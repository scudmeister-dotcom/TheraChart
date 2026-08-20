# refine-response-shoulder.json

A REAL Vertex response to the refine prompt, captured 2026-08-20 against
`therachart-prod` on `gemini-3.7-flash`, for the exact four-line transcript
`tools/capture-screenshots.js` dictates:

    patient reports right shoulder pain seven out of ten, worse reaching overhead
    right shoulder abduction 90 degrees, external rotation 45, deltoid strength 4 out of 5
    we did therapeutic exercise with the theraband and manual therapy to the posterior capsule
    patient tolerated treatment well and reported less pain afterwards

It exists so the screenshot harness can photograph a real AI review without a
live call, now that there is no offline reviewer to fall back on. Point
`GEMINI_BASE_URL` at a stub that replays this and set any non-empty
`GEMINI_API_KEY`; the whole path runs for real — /api/refine, ai.js, the retry
wrapper, HTTP, normalizeRefinement — with only the model's output canned.

The envelope is the generateContent shape (`candidates[].content.parts[].text`
holding the JSON string), which is identical on the Vertex and consumer-API
paths, so a Vertex capture replays correctly through `GEMINI_BASE_URL`.

Not invented, and deliberately so: a fixture someone wrote by hand drifts from
what the model actually returns, and then the picture is of something that
never happened. Recapture rather than edit — the command is in the git history
for this file.

What it contains: 4 dialogue turns, 1 finding (right shoulder, 7/10, worse
overhead). Usage on the captured call was 2,999 prompt / 354 output / 779
thinking tokens.
