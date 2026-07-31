# How to turn FriendMap into a real phone app

This guide turns your website into an Android app that works in the background.
Follow every step in order. Don't skip anything.

---

## PART 1 — Get your computer ready

### Step 1 — Make sure you have Node.js
You already have this (you use it for your other projects). Skip to Step 2.

### Step 2 — Install Android Studio
This is the program that builds Android apps.

1. Go to: **https://developer.android.com/studio**
2. Click the big green **Download Android Studio** button
3. Install it like any normal program (keep clicking Next/Agree)
4. When it opens for the first time, it will ask to install some extra tools
   → Click **Next** on everything and let it download (takes 5–10 min)
5. When it finishes, close Android Studio for now

---

## PART 2 — Set up your FriendMap project

### Step 3 — Open your terminal in the friendmap folder
(Same way you do it for your other projects)

### Step 4 — Install all the packages
Type this and press Enter:
```
npm install
```
Wait for it to finish. You will see a lot of text scroll by — that is normal.

### Step 5 — Set up Capacitor (one time only)
Type this and press Enter:
```
npx cap init FriendMap com.friendmap.app --web-dir out
```
It will ask you a couple of questions — just press Enter to accept the defaults.

### Step 6 — Add Android support
Type this and press Enter:
```
npx cap add android
```
This creates an `android` folder inside your friendmap folder.

---

## PART 3 — Build the app files

### Step 7 — Build your web app
Type this and press Enter:
```
npm run build
```
This creates a folder called `out` — that is what goes inside the Android app.

### Step 8 — Copy your web app into Android
Type this and press Enter:
```
npx cap sync android
```
This copies everything from `out` into the Android project.

---

## PART 4 — Add location permissions in Android Studio

### Step 9 — Open the project in Android Studio
Type this and press Enter:
```
npx cap open android
```
Android Studio will open. Wait for it to finish loading (the bar at the bottom will stop spinning).

### Step 10 — Find the permissions file
On the LEFT side of Android Studio you will see a list of files and folders.

1. Click the little arrow next to **app**
2. Click the little arrow next to **src**
3. Click the little arrow next to **main**
4. Double-click the file called **AndroidManifest.xml**

It will open in the middle of the screen. It looks like code with lots of `<` and `>` symbols.

### Step 11 — Add the location permissions
Find this line in the file (it will be near the top):
```
<manifest xmlns:android=
```

Click at the END of that line, press Enter to make a new line, then copy and paste ALL of this:

```xml
<uses-permission android:name="android.permission.ACCESS_COARSE_LOCATION" />
<uses-permission android:name="android.permission.ACCESS_FINE_LOCATION" />
<uses-permission android:name="android.permission.ACCESS_BACKGROUND_LOCATION" />
<uses-permission android:name="android.permission.FOREGROUND_SERVICE" />
<uses-permission android:name="android.permission.FOREGROUND_SERVICE_LOCATION" />
<uses-permission android:name="android.permission.WAKE_LOCK" />
<uses-permission android:name="android.permission.INTERNET" />
<uses-permission android:name="android.permission.ACCESS_NETWORK_STATE" />
```

### Step 12 — Add the background service
In the SAME file, find this line:
```
<application
```

Scroll DOWN past the `<activity` section until you find the CLOSING tag:
```
</application>
```

Click just BEFORE that `</application>` line, press Enter to make space, then paste this:

```xml
<service
    android:name="com.transistorsoft.locationmanager.service.TrackingService"
    android:foregroundServiceType="location" />
```

### Step 13 — Save the file
Press **Ctrl + S** (or Cmd + S on Mac)

---

## PART 5 — Add your Supabase keys

### Step 14 — Find the assets folder
Still in Android Studio, in the file list on the left:

1. Look for **app → src → main → assets → public**
2. You need to create a file here called **.env**

Actually — easier way:
1. Go back to your terminal
2. Type this:
```
cp .env.local android/app/src/main/assets/public/.env
```
This copies your keys into the Android app.

> ⚠️ Every time you change your .env.local file you need to run this again.

---

## PART 6 — Put the app on your phone

### Step 15 — Turn on Developer Mode on your Android phone
1. Open **Settings** on your phone
2. Scroll down to **About Phone**
3. Find **Build Number**
4. TAP it 7 times in a row
5. You will see a message: "You are now a developer!"

### Step 16 — Turn on USB Debugging
1. Go back to **Settings**
2. You will now see a new option called **Developer Options**
3. Open it and turn on **USB Debugging**

### Step 17 — Plug your phone into your computer with a USB cable
Your phone will ask: "Allow USB Debugging?" → Tap **Allow**

### Step 18 — Run the app on your phone
Back in Android Studio:

1. At the top of the screen you will see a dropdown that says something like "app"
2. Next to it there is another dropdown — click it and select your phone from the list
3. Click the big GREEN PLAY BUTTON ▶ at the top
4. Android Studio will build the app and install it on your phone (takes 2–3 min the first time)
5. The app will open on your phone automatically!

---

## PART 7 — Give the app location permission

### Step 19 — Allow location on your phone
When the app opens it will ask for location permission.

**IMPORTANT:** Choose **"Allow all the time"** (not just "While using the app")

This is what makes it work in the background. If you choose the wrong one:
1. Open phone **Settings**
2. Find **FriendMap** in your app list
3. Tap **Permissions → Location**
4. Choose **Allow all the time**

---

## Every time you update the app code

You only need to do Steps 3–5 again (the quick ones):

```
npm run build
npx cap sync android
```

Then press the green play button in Android Studio again.

---

## What your friends will see

When FriendMap is running in the background, your phone will show a small notification at the top saying **"FriendMap is sharing your location"**.

This is NORMAL and REQUIRED by Android. It is how Android lets apps use GPS in the background. You cannot turn it off, but you can swipe it to minimise it.

---

## Something went wrong?

**"SDK not found" error** → Open Android Studio → Tools → SDK Manager → install Android 14 (API 34)

**Phone not showing up in Step 18** → Unplug and replug the USB cable, tap Allow on your phone again

**App crashes on open** → Go back to terminal, run `npm run build && npx cap sync android` again, then press play

**Location not updating in background** → Make sure you chose "Allow all the time" in Step 19
