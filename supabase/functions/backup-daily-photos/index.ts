import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SUPABASE_SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!

Deno.serve(async (req) => {
  try {
    const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY)

    // Parse optional params from request body
    let room: string | null = null
    let backupAll = true

    try {
      const body = await req.json()
      room = body.room || null
      backupAll = body.all !== false
    } catch {}

    // Fetch ALL photos (not just yesterday)
    let query = sb.from('photo_pins').select('*').order('created_at', { ascending: true })
    if (room) query = query.eq('room', room)

    const { data: photos, error: fetchError } = await query

    if (fetchError) {
      console.error('Error fetching photos:', fetchError)
      return new Response(JSON.stringify({ error: fetchError.message }), { status: 500 })
    }

    if (!photos || photos.length === 0) {
      return new Response(JSON.stringify({
        success: true,
        message: 'No photos found',
        backed_up: 0
      }), { status: 200 })
    }

    console.log(`Backing up ${photos.length} total photos...`)

    let backed_up = 0
    let skipped = 0
    let errors = 0
    const results = []

    for (const photo of photos) {
      try {
        // Extract filename from URL
        const urlParts = photo.photo_url.split('/')
        const fileName = decodeURIComponent(urlParts[urlParts.length - 1].split('?')[0])

        // Group by date
        const dateStr = photo.created_at.slice(0, 10)
        const backupPath = `${dateStr}/${photo.room}/${photo.member_name}-${fileName}`

        // Check if already backed up
        const { data: existing } = await sb.storage
          .from('photo-backups')
          .list(`${dateStr}/${photo.room}`, {
            search: `${photo.member_name}-${fileName}`
          })

        if (existing && existing.length > 0) {
          console.log(`Already backed up: ${backupPath}`)
          skipped++
          results.push({ backup: backupPath, status: 'already_exists' })
          continue
        }

        // Download from photo-pins bucket
        const { data: fileData, error: downloadError } = await sb.storage
          .from('photo-pins')
          .download(fileName)

        if (downloadError || !fileData) {
          console.error(`Failed to download ${fileName}:`, downloadError)
          errors++
          results.push({ backup: backupPath, status: 'download_failed', error: downloadError?.message })
          continue
        }

        // Upload to photo-backups bucket
        const { error: uploadError } = await sb.storage
          .from('photo-backups')
          .upload(backupPath, fileData, {
            contentType: 'image/jpeg',
            upsert: true,
          })

        if (uploadError) {
          console.error(`Failed to backup ${fileName}:`, uploadError)
          errors++
          results.push({ backup: backupPath, status: 'upload_failed', error: uploadError.message })
          continue
        }

        backed_up++
        results.push({
          backup: backupPath,
          status: 'backed_up',
          member: photo.member_name,
          room: photo.room,
          date: dateStr,
        })
        console.log(`✅ Backed up: ${backupPath}`)

      } catch (err) {
        console.error(`Error processing photo ${photo.id}:`, err)
        errors++
      }
    }

    // Save manifest
    const manifest = {
      backed_up_at: new Date().toISOString(),
      total_photos: photos.length,
      successfully_backed_up: backed_up,
      skipped_already_exists: skipped,
      errors,
      photos: results,
    }

    await sb.storage
      .from('photo-backups')
      .upload(
        `manifest-${new Date().toISOString().slice(0, 10)}.json`,
        new Blob([JSON.stringify(manifest, null, 2)], { type: 'application/json' }),
        { upsert: true }
      )

    console.log(`Done: ${backed_up} backed up, ${skipped} already existed, ${errors} errors`)

    return new Response(JSON.stringify(manifest), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })

  } catch (err) {
    console.error('Backup function error:', err)
    return new Response(JSON.stringify({ error: String(err) }), { status: 500 })
  }
})
