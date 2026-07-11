---
'meetcap-renderer': minor
---

Add `cameraBubble` to `CaptureSpec`: when both screen and camera are on, the camera is composited into the recorded video as a circular picture-in-picture bubble (canvas compositor, `createCameraBubbleTrack`). Designed for window captures, where a floating overlay window is not part of the captured pixels; full-screen captures can keep filming an on-screen overlay instead.
