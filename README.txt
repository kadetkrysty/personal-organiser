PERSONAL ORGANISER
==================

A standalone version of the Pinebridge Tasks module for personal use:
daily, weekly and monthly recurring tasks, plus one-off tasks on a set date,
with a name, optional description, priority, status, time, "weekdays only",
and day of week / day of month. Shown as a month calendar or as task lists.
Tasks are grouped into your own lists (for example Home, Work, Health).

It is completely separate from the Pinebridge app. There is no login and no
server database: your tasks are stored in the browser on each device.
Connect your Google account (section 4) and the same tasks appear on all your
devices and in Google Calendar. Settings > Export backup gives you a file copy.


1. RUNNING IT ON A LAPTOP (Windows or Mac)
------------------------------------------
Unzip the folder somewhere permanent (for example Documents).

Windows: double-click "Start Organiser (Windows).bat".
Mac:     double-click "Start Organiser (Mac).command"
         (first time: right-click > Open, then confirm. If macOS asks to
         install "command line developer tools", accept - it provides python3).

The app opens at http://localhost:8765. Keep the small black window open while
you use it. In Chrome or Edge you can then click the "Install" icon in the
address bar so it opens like a normal app.

Important: always use the same address (http://localhost:8765). Tasks are saved
per address and per browser.


2. RUNNING IT ON IPHONE AND ANDROID
-----------------------------------
Phones cannot run a local web server, so the app files have to be opened once
from a secure (https://) web address. After that the app is installed on the
phone, works offline, and your tasks are stored only on the phone.

Upload the contents of this folder to any static web host, for example:
  - a new Replit project published as a Static site
  - GitHub Pages, Cloudflare Pages or Netlify
Then open that https:// address on the phone:
  - iPhone (Safari): Share > Add to Home Screen, then open it from the Home Screen.
  - Android (Chrome): menu > Install app (or Add to Home screen).

Connect the same Google account on each device (section 4) to keep the tasks
identical everywhere.


3. REMINDERS
------------
Settings > Allow pop-up reminders, then "Send test reminder" to check.

  - Tasks synced to Google Calendar: reminders come from Google Calendar on all
    your devices, even when this app is closed. This is the recommended setup.
  - Tasks not synced: this app shows the pop-up only while it is open
    (or open in the background on a laptop). Phones pause apps that are not on
    screen, so use Google Calendar sync for reliable phone reminders.
  - iPhone needs iOS 16.4 or later, and the app must be opened from the
    Home Screen icon for reminders to be allowed.

"Remind me" lets you choose at the task time or 5-60 minutes before.


4. SYNC WITH GOOGLE: ALL DEVICES + GOOGLE CALENDAR (one-time setup, ~10 min)
-----------------------------------------------------------------------------
- Device sync: your tasks and lists are saved to a hidden app-only folder in
  your Google Drive (it does not appear in your normal Drive files). Every
  connected device reads and merges it, so adding, editing or deleting a task on
  one device shows up on the others. If the same task is edited on two devices,
  the most recent edit wins. Works offline too - changes are sent when you are
  back online and sync again.
- Calendar: each task becomes a repeating event in your primary Google Calendar.
  Editing a task updates the event, deleting a task deletes the event.

Google requires your own "OAuth Client ID" so that the app can ask for
permission:

  a. Go to https://console.cloud.google.com and create a project
     (e.g. "Personal Organiser").
  b. APIs & Services > Library > enable BOTH "Google Calendar API" and
     "Google Drive API".
  c. APIs & Services > OAuth consent screen (Google Auth Platform):
     User type "External", app name "Personal Organiser", your email.
     Under Audience / Test users, add your own Google email address.
  d. APIs & Services > Credentials > Create credentials > OAuth client ID:
     Application type "Web application".
     Authorised JavaScript origins - add every address you open the app from:
        http://localhost:8765
        https://your-phone-hosting-address   (from step 2)
     No redirect URIs are needed. Click Create and copy the Client ID.
  e. In the app: Settings > paste the Client ID > Connect Google account,
     sign in and tick BOTH permissions (Calendar, and app data in Drive).
  f. Repeat step e on each of your devices with the same Client ID and the
     same Google account. The first device's tasks appear on the others; the
     empty starter list on new devices is removed automatically.

Because the Google project is in "Testing" mode, Google shows an
"unverified app" warning - this is expected for a personal app; continue.

Google's permission lasts about an hour at a time (a browser-only app cannot
keep a longer sign-in). While it is valid, the app syncs automatically after
every change and every minute while open. After it expires, your changes are
still saved on the device and a "Sync now" bar appears - tap it to sign in
again (usually one tap) and bring all devices up to date.

Disconnect (Settings) only stops syncing on that device; your tasks, your other
devices and your calendar events are not touched.


Files
-----
index.html, app.js, styles.css   the app
sw.js, manifest.webmanifest       offline support and "install as app"
icons/                            app icons
Start Organiser (...)             local launchers for Windows and Mac
