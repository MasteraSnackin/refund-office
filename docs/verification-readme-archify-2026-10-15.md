# Animated Archify README preview — 15 October 2026

This follows the [README refresh](verification-readme-2026-10-15.md) published at `b62c4931b34a9740fab89cd0eb4082d36d23dd79`. It replaces the static architecture preview with a clickable animation and links directly to the existing public [interactive runtime map](https://refund-office.vercel.app/system-map.html). The smaller source-linked overview remains available separately. No application code or hosted release is changed by this update.

## Media checks

The [GIF](images/animated/refund-office-architecture.gif) was converted locally from the frozen 30-second architecture film, whose SHA-256 is `cb6744fa264f9fda14fd16a03db2df21adbccc8ea3d18fc7fc5b3622af9f2807`. The input film is not bundled with this README update. The [encoding manifest](images/animated/refund-office-architecture.encoding.json) records its relative source location, conversion settings and output hashes.

- The GIF is 960×540, contains 240 frames spanning 30.00 seconds and is 2,443,212 bytes. Its SHA-256 is `9bbcf82ed7b8af52323da3adb3b8590c39fdc75342ec3ecbe66ba72a9cdfd8dd`.
- There are 159 distinct composited frames. Full decoding passed, and nine sampled frames plus the [overview still](images/animated/refund-office-architecture.jpg) were inspected. This is sampled visual inspection, not continuous subjective viewing.
- The finite loop setting is the initial pass plus one repeat; individual viewers can override GIF looping. The GIF is silent and retains the label “Illustrated architecture, not live traffic”.
- Small overview labels are easier to read in the interactive map. The GIF preserves focused camera moves and key captions; it has no playback controls.

## Map and link checks

The animation and hosted viewer represent the existing runtime map with 12 components and 14 connections. The [smaller overview](diagrams/readme-overview.sources.md) is a distinct ten-component, source-linked diagram.

The canonical [runtime JSON](diagrams/sponsor-runtime.architecture.json) and [HTML](diagrams/sponsor-runtime.html) still match their [delivery receipt](diagrams/sponsor-runtime.delivery.json): specification SHA-256 `845369f2a9ac17ed6d5338fa5ef9e7ea52a3e5305f1e9a3c620acdd7541fff7b`, artifact SHA-256 `6b4f7cd8f30f44c903a364f0075f42b6bc6eb772b48d82bde6e5222ca08d5ac0`. That receipt records nine showcase checks with no errors or warnings. The unchanged graph was reused; no new diagram delivery is claimed.

A fresh anonymous read of the public viewer returned HTTP 200 and 820,496 bytes, with SHA-256 `fb80cf81481746ec7c07f834d2a83500d3c3373dddd6f88695479c50b9e6fe0c`. It matches the existing `public/system-map.html`, whose presentation wrapper differs from the canonical HTML. The public page opens without sign-in, initially in Still mode. Browser interaction checks enabled Live, played the five guided chapters to completion, then selected Still and confirmed story playback was disabled. Search and route tracing were not retested during this update.

Repository-relative README links were checked. No application tests were rerun for this documentation/media change. Nothing here establishes live provider access, model execution, case approval, payment or authenticated application acceptance.
