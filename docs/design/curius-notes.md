# Curius design notes (reference for margin-comments UI)

Researched 2026-10-26. Values come from reading Curius's shipped code as text, never from running it:

- **Extension v0.2.8.45** (CWS id `fbpnbdifockifjiimogdjndhpmmfgjkl`): content script `dist/helper.js`
  (React + styled-components) and `dist/extension/static/content.css`. This is the main source for values.
- **Web app bundle** `https://curius.app/dist/main.*.js`, plus a headless render of `https://curius.app`.
- **Images**: the 4 Chrome Web Store screenshots (AMO has the same 4) and frames from the official
  "Curius Demo" video (vimeo.com/571634685, 2021). Neither shows a comment thread, so the comment card
  spec comes from code. I checked it by rebuilding the card with the extracted CSS.
  Screenshots stay in the session scratch dir; none are committed here.

## 1. What Curius's in-page UI looks like

**Adder ("Save" button)** (`helper.js`, `selection_bubble`; demo video frame at ~7s):
- A small solid button that says **"Save"**: background `#409FFF`, white `700 12px/1.4 sans-serif`,
  padding `6px 10px`, radius `3px`, no border or shadow, `z-index: 99999999`.
- Desktop position, in document coordinates: `left = range.getBoundingClientRect().right + 10px`,
  `top = rect.top`. On touch devices it sits centered below the selection (+10px).
- Appears on `mouseup` after a `selectstart`; hides when the selection collapses. Its `mousedown` calls
  `preventDefault()`, so clicking it keeps the selection.
- Clicking it creates the highlight right away. It only appears once the page is saved via the toolbar icon.

**Highlights.** Text is wrapped in a custom `<curius class="curius-highlight ...">` element, `cursor: pointer`.
- *Your own:* `hsl(54deg 100% 76%)` = `#FFF385`, `border-radius: 4px`, no border. Hover or jumped-to:
  `#FFE600`. On dark pages: `rgba(124,97,41,1)`, hover `rgba(68,48,3,.9)`.
  Video pixels confirm it (`#fcf389`; Save button `#41a0ff`).
- *Other people's:* a pastel per person, hue hashed from the first name, saturation 55%:
  - `light` = `hsl(h,55%,94%,.5)`: resting background.
  - `medium` = `hsl(h,55%,87%)`: hover background.
  - `dark` = `hsl(h,55%,71%)`: `1px solid` bottom border; avatars use it too.
  - Fallback CSS: `rgba(255,230,0,.1)` with a `#FFE600` underline, `rgba(255,230,0,.3)` on hover.
  - The 2021 video and CWS shot 1 look closer to `medium` (`#d3f2cf`, `#f9c8c7`); current code is fainter.
- Hue function, copied as-is (may return a negative value, which CSS accepts):
  `let a=0; for (let i=0;i<name.length;i++) a=name.charCodeAt(i)+((a<<5)-a); const h=a%360;`

**Margin notes (Curius's equivalent of a comment popover):**
- There is no floating popover. Each highlight gets a note in the right margin, like Google Docs.
- Position: absolute, `top` = the highlight's top, `left` = the rightmost highlight's right edge + 15px.
  Recomputed on resize, debounced 200ms.
- Width `200px`. Container font `14px "Source Sans Pro"`, color `rgb(33,37,41)`.
- Card: `border-radius: 8px; padding: 5px; margin-top: -5px`. It turns white once it has a comment or
  while hovered or edited.
  - Emphasized (card or its highlight hovered): `box-shadow: 0 2px 6px 2px rgb(60 64 67 / 15%)`, the
    Google-Docs shadow. Otherwise no shadow and no border.
- At rest your own highlight shows only an **8px goldenrod dot** (`rgb(240,187,0)`, video ~8s), which
  glows `0 0 5px` on hover. Hover also reveals grey 16px icons (comment, trash) via a
  `clip-path: circle(18%) -> circle(100%)` reveal over 200ms.
- Composer:
  - Textarea `12px verdana`, `1px solid #ccc`, radius `4px`, placeholder **"Comment or share with @"**.
  - **Enter submits, Shift+Enter adds a newline.**
  - Right-aligned below it: a lowercase **"cancel"** link (grey 12px) and an 18px round up-arrow submit
    icon, `#C4C4C4` when idle and `#007bff` once there's text.
- Other people's highlights show **name + "5 days ago"** in the margin: black 14px Source Sans name, grey
  time (video ~15s).

**Comment thread** (`ke.c` in helper.js):
- Wrapper `11px/1.38 verdana`. Replies are indented `20px`.
- Each comment has a name row (`13px Source Sans Pro`, name bold, padding `5px 0 0 10px`) and a text block:
  `padding: 5px 10px; border-radius: 14px; white-space: pre-wrap; width: fit-content`.
  Background is transparent (`rgba(248,248,249,.9)` while replying).
- Links: **"Reply"** is `10px` grey, right-aligned, shown and underlined on hover. **"delete"** is
  `12px 600` black. A 20px "..." button gets an `#eee` circle on hover.
- Reply box: textarea `11px verdana`, `1px solid lightgrey`, radius `4px`, padding `5px`, margin `5px`,
  placeholder "Reply". Once there's text, two buttons appear:
  - **Cancel**: plain text, `600 14px #505050`.
  - **Save**: pill with `1px solid lightgrey`, radius `15px`, padding `2px 10px`, `600 14px #505050`.

**Presence bar, top right.** Fixed: a chevron, then one avatar per person who saved or highlighted the
page, then **Share**.
- Avatars: ~30px circles in the person's `dark` color with a white initial (CWS shot 1: N = `#8a8dd9`).
  - "Block" style, slightly neo-brutalist: `1px solid #000` border plus a solid black copy offset 1px
    (`::after`); hover moves it `translate(2px,2px)` over 0.1s.
  - Count badge: 12px white circle, `1px solid grey`, `9px` text, at top:-5px / right:-5px.
- Share button: `1px solid black`, radius `3px`, padding `2px 5px`, white, `#eee` on hover.
- Tooltips: background `#eee`, black text, padding `5px`, max-width `200px`
  (e.g. "Noah | 3 days ago / 1 highlight").
- Clicking an avatar steps through that person's highlights (`scrollIntoView({block:'nearest'})` plus
  the hover color).

**Sidebar.** Curius has no thread sidebar on normal pages. The closest references:
1. **PDF mode sidebar**: width `20vw`, text `#777`, warm off-white background
   `linear-gradient(#f9f8f7, #fbfaf8 46px, #fbfbf9 120px, #f8f7f5 35%, #f9f8f6)`.
   - Items: padding `1rem`, `border-bottom: 1px solid #777`; hover and selected `rgba(58,56,52,.08)`.
   - Quote `14px` in curly quotes, cut at 100 characters; location line `10px`, right-aligned.
2. **Bookshelf and new-tab lists** (CWS shots 3–4, curius.app home):
   - Title `14px Source Sans Pro` black; domain and time `12–13px #aaa`; names `13px rgba(0,0,0,.5)`.
   - Quotes: `Lora 12px/1.6 rgba(0,0,0,.54)` on `rgba(240,230,0,.2)`, clamped to 2 lines.
   - Rows: padding `8px 20px`, `border-bottom: 1px solid #f3f4f6`. Selected rows get a
     `1px solid rgb(108 133 199 / 33%)` border; rows focused on one user get a left border in their
     `medium` color.

**General feel.** White, almost no borders, shadows only on emphasis. Grey and lightgrey icons turn
**yellow** (`rgb(241,200,87)`) on hover. Small type (10–14px). Yellow brand color, indigo secondary.

## 2. Tokens (paste into the shadow root's `:host`)

```css
:host {
  /* type */
  --mc-font-ui: "Source Sans Pro", "Source Sans 3", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
  --mc-font-comment: verdana, sans-serif;  /* comment bodies + textareas */
  --mc-font-quote: Lora, Georgia, serif;   /* quoted highlight text in lists */
  --mc-fs-card: 14px; --mc-fs-name: 13px; --mc-fs-comment: 11px; --mc-lh-comment: 1.38;
  --mc-fs-input: 12px; --mc-fs-reply-input: 11px; --mc-fs-meta: 12px; --mc-fs-link: 10px;
  --mc-fs-quote: 12px; --mc-lh-quote: 1.6; --mc-fw-name: 600; --mc-fw-button: 600;
  /* text */
  --mc-text: rgb(33,37,41); --mc-text-strong: #000; --mc-text-button: #505050;
  --mc-text-muted: grey;  /* #808080: time-ago, Reply, cancel, icons */
  --mc-text-faint: #aaa; --mc-text-soft: rgba(0,0,0,.5); --mc-text-quote: rgba(0,0,0,.54);
  --mc-icon-idle: lightgrey; --mc-icon-hover: rgb(241,200,87);  /* Curius "primary" yellow */
  /* surfaces + lines */
  --mc-bg: #fff; --mc-bg-hover: #eee; --mc-bg-row-hover: #fcfcfc; --mc-bg-replying: rgba(248,248,249,.9);
  --mc-bg-chip: #f1f1f1; --mc-bg-chip-hover: #dedede; --mc-bg-tooltip: #eee;
  --mc-border: lightgrey; --mc-border-input: #ccc; --mc-border-row: #f3f4f6; --mc-border-thread: #eee;
  --mc-border-selected: rgb(108 133 199 / 33%);
  /* accents */
  --mc-adder-bg: #409FFF; --mc-adder-fg: #fff; --mc-send-idle: #C4C4C4; --mc-send-active: #007bff;
  --mc-yellow: #FFE600; --mc-goldenrod: rgb(240,187,0); --mc-pale-yellow: rgba(255,200,0,.2);
  --mc-indigo: #3949ab; --mc-indigo-soft: #6877d0; --mc-indigo-pale: #e3e5f1; --mc-indigo-subtle: rgb(108,133,199);
  /* highlights: light DOM, so set these on the highlight elements too. --h = hash(firstName) % 360 */
  --mc-hl-own: #FFF385; --mc-hl-own-active: #FFE600;  /* #FFF385 = hsl(54deg 100% 76%) */
  --mc-hl-own-dark-page: rgb(124,97,41); --mc-hl-own-dark-page-active: rgba(68,48,3,.9);
  --mc-hl-other: hsl(var(--h) 55% 94% / .5); --mc-hl-other-underline: hsl(var(--h) 55% 71%);
  --mc-hl-other-active: hsl(var(--h) 55% 87%); --mc-avatar-bg: hsl(var(--h) 55% 71%);
  /* shape */
  --mc-radius-hl: 4px; --mc-radius-button: 3px; --mc-radius-input: 4px; --mc-radius-card: 8px;
  --mc-radius-bubble: 14px; --mc-radius-pill: 15px; --mc-radius-chip: 6px;
  --mc-shadow-card: 0 2px 6px 2px rgb(60 64 67 / 15%); --mc-shadow-overlay: 0 0 10px 2px rgb(0 0 0 / 8%);
  --mc-shadow-dot: 0 0 5px rgb(240,187,0); --mc-shadow-block: 1px 1px 0 #000;
  /* spacing, size, motion */
  --mc-card-width: 200px; --mc-card-pad: 5px; --mc-margin-gap: 15px; --mc-adder-gap: 10px;
  --mc-adder-pad: 6px 10px; --mc-bubble-pad: 5px 10px; --mc-name-pad: 5px 0 0 10px;
  --mc-reply-indent: 20px; --mc-input-pad: 5px; --mc-input-margin: 5px; --mc-row-pad: 8px 20px;
  --mc-dot: 8px; --mc-avatar: 30px; --mc-badge: 12px; --mc-icon: 16px;
  --mc-ease: .1s ease-in-out; --mc-reveal: 200ms;
}
```

## 3. Recommendations for our UI

**Adder:**
- Copy Curius exactly (`#409FFF` chip, white `700 12px` text, `6px 10px` padding, `3px` radius), but
  label it **"Comment"** instead of "Save".
- Place it 10px right of the selection's bounding rect, top-aligned. Keep the `mousedown`
  preventDefault. Show on mouseup; hide on collapse or Escape.
- Clicking it opens the composer at that spot. Unlike Curius, create the highlight only when the first
  comment is posted.

**Highlights:**
- Threads you started or replied to use `--mc-hl-own` with a 4px radius, and `#FFE600` when hovered or open.
- Everyone else's threads use the author's hue: light background plus a 1px dark bottom border, medium
  shade on hover or while open.
- Curius's resting `94%/.5` is very faint on white. If testers can't see it, use opaque `hsl(h 55% 90%)`.
- Resolved threads: no highlight, or only the underline. (Curius has no "resolved" state; this is ours.)
- Detect dark page backgrounds and switch to the dark-page tokens.

**Thread popover:**
- Prefer Curius's margin placement: when the page has ≥ 215px free right of the text, dock the card at
  `top = highlight top`, `left = max right + 15px`.
- Otherwise float it 8px below the highlight, clamped to the viewport.
- Card: width 200px (240px max if the action row needs it), white, `8px` radius, `5px` padding,
  `--mc-shadow-card`, no border.
- Inside, top to bottom:
  1. **Header row**, 16px tall: author dot or avatar, then right-aligned icons (resolve check, "...").
     Icons are `lightgrey` at rest, `grey` while the card is hovered, yellow `rgb(241,200,87)` on hover,
     each with an `#eee` round hover background.
  2. **Each comment**: name `600 13px` black, time-ago `400 13px grey` ("5 days ago"), then the body in
     `11px/1.38 verdana` with `5px 10px` padding.
     - Own comments get "edit" and "delete" as `12px 600` text links on hover. Replies indent 20px.
     - If verdana 11px reads too small next to Source Sans, use `12px` and say so in DECISIONS.md.
  3. **Reply box**: placeholder "Reply", styled as in the thread spec. With text, show `Cancel` (text
     button) and `Save` (pill). Enter submits; Shift+Enter adds a newline.
- New-thread composer: the same card holding only a textarea (`12px verdana`, `#ccc` border),
  placeholder "Add a comment", right-aligned "cancel" link, round arrow send icon (`#C4C4C4` → `#007bff`).

**Sidebar (list of threads):**
- Fixed right panel, ~300px (Curius's PDF sidebar is 20vw), white, `1px solid #f3f4f6` left border,
  `--mc-shadow-overlay`.
- Header: `600 14px` Source Sans, with All / Open / Resolved filter chips (`#f1f1f1`, `10px` uppercase,
  `6px` radius).
- Rows: `8px 20px` padding, `1px solid #f3f4f6` dividers, hover `#fcfcfc`, selected row
  `1px solid rgb(108 133 199 / 33%)`. Each row has:
  - The quote in `Lora 12px/1.6 rgba(0,0,0,.54)` on the author's highlight color, clamped to 2 lines.
  - A meta line: name `13px rgba(0,0,0,.5)`, then reply count and time in `12px #aaa`.
  - The first comment, 1 line, in `--mc-text`.
- Orphaned threads: no highlight color on the quote, plus a grey "Text not found" chip.
- Launcher: copy Curius's top-right presence bar. Participants' avatars (30px, hue fill, white initial,
  block border and offset) with a 12px count badge; clicking toggles the sidebar.

**Implementation notes:**
- Bundle Source Sans 3 and Lora as woff2 files (OFL licensed) and register them with the `FontFace` API on
  `document.fonts`. `@font-face` inside a shadow root is ignored in Chrome, and page CSP can block Google Fonts.
- Curius uses `all: initial` instead of Shadow DOM. We still need it on the light-DOM highlight wrapper.

**Uncertain or not observed:**
- No public screenshot shows Curius's comment card; that spec is from code plus a reconstruction render.
- Avatar size (~30px) is from screenshots; I didn't trace it in code.
- Mobile and narrow viewports were not observed.
