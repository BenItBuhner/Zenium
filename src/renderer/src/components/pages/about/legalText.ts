/**
 * The legal pages' text (SET-55): the Privacy notice and the Terms Settings › Legal opens as
 * `zen://privacy-notice` and `zen://terms`, in the markdown `lib/prose.ts` reads. The
 * repository carries no legal text of its own beyond its Apache-2.0 licence, so this is a plain
 * first statement of what the program does with data and on what terms it is provided – every
 * sentence a fact of the code as it stands – for the project to replace with its own words; the
 * pages render whatever stands here.
 */

export const PRIVACY_NOTICE = `Zenium is a browser that keeps what it knows about your browsing on your device.

## What stays on your device

- Your history, bookmarks, open tabs, spaces and downloads list are stored in this app's own storage on this device.
- Saved passwords, passkeys, addresses and payment methods are kept in a vault on this device, each entry encrypted (AES-256-GCM) under a key the device's keystore or your own passphrase protects.
- Site data – cookies, caches, site storage and permissions – is held by the web engine on this device for the sites you visit, and is cleared from Settings › Privacy and Security whenever you choose.
- Private tabs write nothing to history and keep their site data in memory alone.

## What leaves your device

- Pages load from the sites you visit, and requests to those sites carry what the web engine needs to load them. Content blocking, when it is on, removes the tracking and advertising requests its lists name.
- Typing in the address bar asks your chosen search engine for suggestions when Settings › Search allows it, and a search goes to that engine.
- Checking for updates fetches the release list from this project's GitHub repository. Nothing about you rides with the request.
- Password checkup and the sign-in leak warning look a password up in the Have I Been Pwned range API by the first characters of its hash alone; the password itself never leaves the device.
- Sync, when you set it up, writes your data as AES-256-GCM ciphertext under your own passphrase into the folder you choose; the project runs no sync service and holds no key.
- Zenium has no analytics, telemetry or crash reporting of its own, and no account.

## Your choices

Settings › Privacy and Security holds content blocking, site data, permissions and private tabs; Settings › Search holds the suggestions switch; Settings › Passwords holds the checkup. Everything this app stores goes with it when it is uninstalled.

This notice describes Zenium as built from its source at the version shown in Settings › About.`

export const TERMS = `Zenium is free and open-source software, provided under the Apache License, Version 2.0.

## Licence

You may use, copy, modify and distribute Zenium under the terms of the Apache License, Version 2.0. The licence's full text is kept with the source at https://github.com/BenItBuhner/Zenium and at http://www.apache.org/licenses/LICENSE-2.0.

## No warranty

As the licence states, the software is provided "as is", without warranties or conditions of any kind, express or implied. The project and its contributors are not liable for any damages arising from its use, to the extent the law allows.

## Web content and third parties

The pages, services and extensions you use through Zenium are provided by others, under their own terms. Zenium is a port of the Zen Browser's design onto Chromium's engine; it is not affiliated with the Zen team, with Google or with the Chromium project.

## Changes

These terms follow the software: the version shown in Settings › About is the one they describe.`
