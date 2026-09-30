# Fix Required Report

I reviewed the extension code in this project and found several bugs that should be fixed before relying on this app in production.

## Bugs found

### 1) Capture UI can get stuck if video stop fails
- File: `popup.js`
- Area: `endCaptureAndSave()`
- Issue: If `toggleVideo()` fails while closing a capture, the function exits early and never resets the popup state. That leaves the extension in a half-recording state (`capturing` stays true and the session name remains disabled) even though the user is no longer recording.
- Risk: Users can no longer recover without reloading the extension, and the app can appear stuck or inconsistent.

### 2) Network capture state can become orphaned after a failed attach
- File: `background.js`
- Area: `startNetworkCapture()`
- Issue: `state.networkCapturing = true` is set before `chrome.debugger.attach()` and `Network.enable` complete. If either call throws, the debugger listener stays attached and the state remains true, leaving the extension in a bad runtime state with no clean recovery.
- Risk: The app can continue to think it is recording even though the debugger is partially attached or detached.

### 3) Response bodies can be lost or overwritten because request correlation is not cleaned up
- File: `background.js`
- Area: `onDebugEvent()` / `_requestMap`
- Issue: Requests are tracked in `state._requestMap` but never cleaned up when a request finishes or after a session ends. If a response arrives late, duplicate IDs are reused, or a request is aborted, the response body may get attached to the wrong entry or disappear entirely.
- Risk: Network evidence can be incomplete or misleading, particularly for long-running or failing requests.

### 4) Saved scenario data is kept by reference instead of being cloned
- File: `background.js`
- Area: `saveScenario()` and `resetEvidence()`
- Issue: The saved `scenario` object stores references to the live arrays (`screenshots`, `networkLogs`, `videoChunks`). Those arrays are later replaced via `state.screenshots = []`, etc. If the same array objects are reused or mutated further, the saved data can become inconsistent or stale.
- Risk: Exported evidence may not match what the user actually captured.

### 5) Video capture assumes modern browser APIs and can fail silently
- File: `offscreen.js`
- Area: `startRecording()`
- Issue: `getUserMedia` uses old `mandatory` constraints for `chromeMediaSource` and has no guard for missing or invalid `streamId`. On some Chrome versions or tab-capture permission changes, this can fail silently or throw before recording begins.
- Risk: Video evidence is not recorded even though the user started capture.

### 6) Screenshot capture does not validate the active tab before debugger access
- File: `background.js`
- Area: `captureScreenshot()`
- Issue: The code assumes `chrome.tabs.query({ active: true, currentWindow: true })` always returns a usable tab. On Chrome internal pages, closed tabs, or permission-denied states, the code can throw before attaching the debugger.
- Risk: A single unsupported page can break the capture flow and produce a confusing error for the user.

## Good suggestions

1. Add a single, centralized lifecycle guard for all capture sessions so start/stop errors cannot leave partial state behind.
2. Clone arrays before storing them in `scenarios` and treat saved data as immutable snapshots.
3. Add request cleanup to `state._requestMap` when network requests finish, fail, or are canceled.
4. Add explicit validation of the active tab and required tab-capture permissions before calling `chrome.debugger` and `getUserMedia`.
5. Add retries and timeouts for video chunk transfer messages so large recordings are less likely to fail mid-transfer.
6. Add unit or integration tests around the start/stop capture flow, including failure cases, to prevent regression.
7. Consider storing scenario data in a dedicated immutable model or `structuredClone()`-based copy so saved evidence cannot be mutated unexpectedly.
8. Add a "Reset / Recover" action in the popup so users can recover from stale capture state without reloading the extension.

## Summary

This project does have real issues that should be fixed: UI state can become stuck, network capture can leave the debugger in a bad state, saved evidence may be inconsistent, and video capture is fragile in unsupported browser conditions. The highest-priority items are the lifecycle cleanup and immutable save behavior.
