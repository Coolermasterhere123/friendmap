import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js";

// Configuration - these will be set as secrets
const RESEND_API_KEY = Deno.env.get('RESEND_API_KEY') || '';
const SUPABASE_URL = Deno.env.get('PROJECT_URL') || '';
const SUPABASE_ANON_KEY = Deno.env.get('ANON_KEY') || '';
const ROOM_ID = '1234'; // Room 1234
const YOUR_EMAIL = 'coolermaster123@protonmail.com';

// Only include photos from Brandi and Wes
const ALLOWED_MEMBERS = ['mmha1vk2', 'ba3x1w5e'];

// App URL - change this to your actual app URL
const APP_URL = 'https://friendmap-xi.vercel.app/'; // ← CHANGE THIS to your app URL

Deno.serve(async (req) => {
  try {
    console.log('📸 Starting daily photo summary...');
    console.log('🔑 Checking environment variables:');
    console.log('  - PROJECT_URL exists:', !!SUPABASE_URL);
    console.log('  - ANON_KEY exists:', !!SUPABASE_ANON_KEY);
    console.log('  - RESEND_API_KEY exists:', !!RESEND_API_KEY);
    console.log('  - ROOM_ID:', ROOM_ID);
    console.log('  - YOUR_EMAIL:', YOUR_EMAIL);
    console.log('  - ALLOWED_MEMBERS:', ALLOWED_MEMBERS);

    if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
      console.error('❌ Missing Supabase credentials!');
      return new Response(
        JSON.stringify({ error: 'Missing Supabase credentials' }), 
        { status: 500 }
      );
    }

    // 1. Fetch photos from the last 24 hours
    console.log('📡 Creating Supabase client...');
    const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
    
    console.log('📡 Fetching photos...');
    const { data: photos, error } = await supabase
      .from('photo_pins')
      .select('*')
      .eq('room', ROOM_ID)
      .in('member_id', ALLOWED_MEMBERS)
      .gte('created_at', new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString());
    
    if (error) {
      console.error('❌ Error fetching photos:', error);
      return new Response(
        JSON.stringify({ error: error.message }), 
        { status: 500 }
      );
    }
    
    console.log(`📸 Found ${photos?.length || 0} photos from ${ALLOWED_MEMBERS.length} member(s)`);
    
    // Build the daily review link
    const today = new Date().toISOString().split('T')[0];
    const dailyLink = `${APP_URL}daily?date=${today}&room=${ROOM_ID}`;
    
    // 2. Build the HTML email
    const photosHtml = photos && photos.length > 0
      ? photos.map((photo, idx) => {
          const taken = new Date(photo.created_at);
          const dateStr = taken.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
          const timeStr = taken.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
          const lat = photo.lat ? photo.lat.toFixed(5) : '';
          const lng = photo.lng ? photo.lng.toFixed(5) : '';
          const mapsLink = photo.lat ? `https://www.google.com/maps?q=${photo.lat},${photo.lng}` : '';
          return `
          <div style="margin: 0 0 32px 0; background: #1a2744; border-radius: 12px; overflow: hidden; border: 2px solid ${photo.member_color || '#38bdf8'};">
            <img src="${photo.photo_url}" 
                 style="width:100%; height:auto; display:block; max-height:600px; object-fit:contain; background:#0f172a;" />
            <div style="padding: 14px 16px;">
              <div style="font-size:16px; font-weight:700; color:${photo.member_color || '#38bdf8'}; margin-bottom:6px;">
                📸 Photo ${idx + 1} of ${photos.length} · ${photo.member_name || 'Unknown'}
              </div>
              <div style="font-size:14px; color:#94a3b8; margin-bottom:4px;">📅 ${dateStr}</div>
              <div style="font-size:14px; color:#94a3b8; margin-bottom:4px;">🕐 ${timeStr}</div>
              ${mapsLink ? `<div style="font-size:13px; margin-top:8px;"><a href="${mapsLink}" style="color:#38bdf8;">📍 View on Google Maps (${lat}, ${lng})</a></div>` : ''}
            </div>
          </div>
        `}).join('')
      : `<p style="color:#94a3b8;">No photos were taken in the last 24 hours.</p>`;
    
    const html = `
    <!DOCTYPE html>
    <html>
    <head>
      <style>
        body { 
          font-family: system-ui, -apple-system, sans-serif; 
          background: #0f172a; 
          color: #f1f5f9; 
          padding: 20px; 
          margin: 0;
        }
        .container { 
          max-width: 800px; 
          margin: 0 auto; 
          background: #1e293b; 
          border-radius: 16px; 
          padding: 30px; 
        }
        .header { 
          text-align: center; 
          border-bottom: 2px solid #38bdf8; 
          padding-bottom: 20px; 
          margin-bottom: 20px; 
        }
        .header h1 { 
          color: #38bdf8; 
          margin: 0; 
          font-size: 24px;
        }
        .header p { 
          color: #94a3b8; 
          margin: 5px 0 0; 
        }
        .daily-review-banner {
          margin: 20px 0;
          padding: 16px;
          background: #1e3a5f;
          border-radius: 12px;
          text-align: center;
          border: 2px solid #38bdf8;
        }
        .daily-review-banner a {
          color: #38bdf8;
          font-size: 18px;
          font-weight: 600;
          text-decoration: none;
          display: block;
        }
        .daily-review-banner p {
          color: #94a3b8;
          font-size: 13px;
          margin-top: 5px;
          margin-bottom: 0;
        }
        .gallery { 
          display: flex;
          flex-direction: column;
          gap: 0;
        }
        .footer { 
          margin-top: 30px; 
          text-align: center; 
          color: #64748b; 
          font-size: 12px; 
          border-top: 1px solid #334155;
          padding-top: 20px;
        }
        @media only screen and (max-width: 600px) {
          .photo-item {
            max-width: 100%;
            min-width: 100%;
          }
        }
      </style>
    </head>
    <body>
      <div class="container">
        <div class="header">
          <h1>📸 Daily Photo Summary</h1>
          <p>${photos?.length || 0} photo${(photos?.length || 0) !== 1 ? 's' : ''} taken in the last 24 hours</p>
          <p style="font-size:12px; color:#64748b; margin-top:10px;">
            Room: ${ROOM_ID}
          </p>
        </div>

        <!-- 🔗 Daily Review Link -->
        <div class="daily-review-banner">
          <a href="${dailyLink}">
            🗺️ View Your Day on the Map
          </a>
          <p>
            See all photos and locations on an interactive map
          </p>
          <p style="font-size:11px; color:#475569; margin-top:8px;">
            ${dailyLink}
          </p>
        </div>

        <div class="gallery">
          ${photosHtml}
        </div>
        <div class="footer">
          Generated on ${new Date().toLocaleDateString()} · Powered by Supabase
          <br>
          <span style="font-size:10px; color:#475569;">
            To stop receiving these emails, delete the cron schedule in your Supabase dashboard.
          </span>
        </div>
      </div>
    </body>
    </html>
    `;
    
    // 3. Send the email using Resend API
    console.log('📧 Sending email via Resend...');
    
    if (!RESEND_API_KEY) {
      console.error('❌ Missing Resend API key!');
      return new Response(
        JSON.stringify({ error: 'Missing Resend API key' }), 
        { status: 500 }
      );
    }
    
    const resendResponse = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${RESEND_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        from: 'Daily Summary <onboarding@resend.dev>',
        to: [YOUR_EMAIL],
        subject: `📸 Daily Photo Summary - ${new Date().toLocaleDateString()}`,
        html: html
      })
    });
    
    const responseData = await resendResponse.json();
    
    if (!resendResponse.ok) {
      console.error('❌ Email send failed:', responseData);
      return new Response(
        JSON.stringify({ error: responseData }), 
        { status: 500 }
      );
    }
    
    console.log('✅ Daily photo summary sent successfully!');
    console.log('📧 Email ID:', responseData.id);
    
    return new Response(
      JSON.stringify({ 
        success: true, 
        photos: photos?.length || 0,
        emailId: responseData.id 
      }), 
      { 
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      }
    );
    
  } catch (error) {
    console.error('🔥 Error:', error);
    return new Response(
      JSON.stringify({ error: error.message }), 
      { status: 500 }
    );
  }
});