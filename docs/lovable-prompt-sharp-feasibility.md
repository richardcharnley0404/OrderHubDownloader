# Prompt for Lovable — Can OrderHub use `sharp` for image rotation?

## Context

I have a Node.js/Electron desktop companion app (OrderHub Downloader) that processes film scans. It uses **sharp** (https://sharp.pixelplumbing.com/, npm package `sharp`, currently v0.34.5) for all image manipulation. sharp is a native Node module wrapping libvips, shipped with prebuilt binaries for the major platforms.

In the Downloader, rotation is a one-liner:

```js
await sharp(inputPath).rotate(angle).toFile(outputPath);
// angle is one of 90, 180, 270
```

I'm about to add a manual rotation review feature to OrderHub so lab operators can rotate film scans that our AI orientation model wasn't confident about. **Ideally OrderHub uses sharp too, so the rotation library is identical end-to-end** — no subtle differences in how the pixel rotation is applied, no colour profile drift, no interpolation surprises, no "it looks different in the browser than in the final print" class of bug.

## What I need you to answer (please don't start building)

1. **Can the Lovable stack run sharp server-side?** For example inside a Supabase Edge Function, a Node backend attached to the project, or any other server environment Lovable supports. If yes, tell me where it runs and the constraints — cold start, deployment size (sharp + libvips binary is ~30 MB), memory limits, execution time limits.

2. **If sharp isn't directly runnable in the default Lovable stack**, what server-side options does Lovable support where I could host a small Node service that runs sharp, and have OrderHub call into it? (I don't want to stand up entirely new infra if I don't have to — I'd prefer to use whatever Lovable already offers.)

3. **If neither of the above is feasible**, what's your recommended alternative for server-side image rotation that will produce visually identical output to sharp on the same input? I'd rather not use a browser-canvas rotation because the final pixel operation needs to match what the Downloader produces.

4. **Alternative architecture to weigh in on** — rather than OrderHub rotating the image itself, OrderHub simply records the operator's chosen angle (90, 180, or 270) against the image record in the database, and the Downloader picks that value up and applies the rotation with sharp on its end. This gives us single-library consistency by keeping all pixel operations in one place. Is there anything about OrderHub's current image-handling flow, or any reason related to how the reviewer will experience the UI, that would make this option awkward? If this is the cleanest answer, say so.

Please answer each of the four questions directly with reasoning, and then give me your overall recommendation. No code yet.
