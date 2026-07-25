# Persado Chrome Extension — Design Reference

**Status:** Active. This document is the source of truth for the extension's visual identity.
**Origin:** Direction set by Claude Design, reviewed 2026-07-25. Supersedes the purple/magenta gradient styling in `extension/sidepanel.html`.
**Scope:** Toolbar icon, side panel, and all user-facing copy.

---

## 1. Brand identity

The extension had drifted into its own purple/magenta gradient identity that matched nothing at persado.com. This document realigns it with the real Persado brand: a **black wordmark flanked by red brackets** — `[ Persado ]`.

Two consequences follow, and they are not negotiable:

The **purple → magenta gradient is deprecated.** Every surface that currently uses it (the panel header, primary buttons, badges) moves to the black/red/white system below. Red is an *accent*, not a background — it appears in the brackets, the recording state, and small emphasis moments. It never becomes a large filled area.

The **toolbar icon and the in-panel wordmark must be the same mark.** Today the toolbar shows a lowercase `p` between two plain vertical bars while the panel shows a purple `persado` wordmark. They read as two different products. Both become the bracketed mark.

### Exact values

These are sampled from the shipped icon and are the canonical brand values:

```
Ink (wordmark, primary text)   #1A1128
Persado red (brackets, accent) #DC2828
Surface                        #FFFFFF
```

### The mark

An uppercase **P** in ink, enclosed in red brackets: `[P]`. The brackets are true bracket forms — vertical stem with short horizontal returns at top and bottom — not plain vertical bars. The current icon uses bare bars and a lowercase `p`; both are corrected.

The mark is used at two scales. As the **toolbar icon** it is the bracketed `P` alone. As the **panel wordmark** it is the full `[ Persado ]` lockup in the same ink and red.

---

## 2. Color tokens

```css
:root {
  /* Brand */
  --ink:        #1A1128;  /* wordmark, primary text */
  --red:        #DC2828;  /* brackets, recording, accent */

  /* Surfaces */
  --surface:    #FFFFFF;
  --surface-2:  #F7F6F9;  /* subtle section fill */
  --border:     #ECEAF0;  /* hairline */

  /* Text */
  --text-1:     #1A1128;
  --text-2:     #5C506C;
  --text-3:     #9088A0;  /* muted */

  /* State */
  --amber:      #F59E0B;  /* working / compliance flag */
  --amber-bg:   #FFFBEB;
  --amber-text: #92400E;
  --green:      #10B981;  /* results / compliance clear */
  --green-bg:   #ECFDF5;
  --green-text: #065F46;
}
```

Red carries meaning. Reserve it for the brackets, the live recording state, the selected state of a choice chip, the record dot inside the primary button, and single points of emphasis such as the footer stat figure. Amber means *in progress* or *needs review*. Green means *complete*, *clear*, or *ready*. Do not use red as a large fill — a primary button is ink-filled (`--ink`) with white text, never red.

### Components

**Choice chip.** A pill with a hairline border used for single-select options. Unselected: `--text-1` label on white with a `--border` outline. Selected: `--red` label on white with a `--red` outline. Chips wrap onto multiple rows; they are not scrollable.

**Status chip.** Sits top-right in the panel header. A small filled dot plus an uppercase letter-spaced label — green for READY and for completed states, red for RECORDING, amber for WORKING.

**Primary button.** Full width, ink fill, white 15/700 label, 10px radius. When the action starts a recording it carries a filled red dot to the left of the label.

---

## 3. Typography

Inter throughout, with a mono face (JetBrains Mono / SF Mono) reserved for the page URL and the toolbar-icon spec labels only.

The prior design applied uppercase mono micro-labels to nearly every element, which reads as noise in a narrow panel. One uppercase label style, used once per screen, is the limit.

```
Screen title      18px / 700
Variant headline  15px / 700
Body              13px / 400
Section label     11px / 600, uppercase, letter-spacing .08em  — once per screen
Micro / meta      11px / 500, --text-3
```

Spacing runs on a 4px scale (8 / 12 / 16 / 24). Radius is 12px for cards, 10px for controls, 8px for the icon tile. Borders are hairlines; avoid heavy shadows, using a soft shadow on hover only.

---

## 4. Toolbar icon — state system

**This is the first build target.** The extension currently ships five static PNGs and calls neither `chrome.action.setIcon` nor `setBadgeText`, so it has no state feedback at all. The user cannot tell from the toolbar whether Persado is recording, thinking, or done.

The governing rule: **the mark itself never changes color.** It is always the ink `P` in red brackets. State is carried *only* by a corner badge. This keeps the brand stable and makes the states readable at 16px, where a recolored glyph would just look broken.

| State | Badge | Meaning | Tooltip |
|---|---|---|---|
| **Ready** | none | Default, idle | `Persado — ready` |
| **Recording** | solid red dot, pulsing | Mic is live | `Persado — recording` |
| **Working** | amber dot with `…` | AI generating | `Persado — working` |
| **Results** | green dot with variant count (`3`) | Variants ready | `Persado — 3 variants ready` |
| **Disabled** | none, mark at ~40% opacity | Unsupported page | `Persado — not available on this page` |

The badge sits at the **top-right corner** of the mark. At 16px it is a small dot roughly 6px across; the count numeral appears only when it fits legibly, and the badge falls back to a plain colored dot when it does not.

Chrome's native badge API (`chrome.action.setBadgeText` + `setBadgeBackgroundColor`) handles the count and the colored pill. The disabled state uses a separate dimmed icon set via `setIcon`. The pulsing recording dot cannot be animated through the badge API, so it is driven by alternating between two icon frames on a timer, or — if that proves visually noisy — by a steady red badge, which is acceptable.

### 16px legibility

The mark must survive at real toolbar size. The brackets stay at least 1px clear of the `P`, stroke weights hold at 2px minimum, and the whole lockup keeps ~1px padding inside the 16px box. Test at 16px on both light and dark Chrome themes before accepting the result.

---

## 5. Panel screen states

Four states, all in the side panel (tall, docked). Nothing opens a tab or covers the page at any point.

**1a — Start.** Plain-language copy (`Record your brief`), objective presented as selectable chips rather than a dropdown, and a short privacy note beneath the record button explaining what is captured. One click starts recording; there is no separate configure step. The record button is pinned to the bottom of the panel with the footer stat below it, so the primary action sits in the same place regardless of how much content is above it.

**1b — Recording.** A running timer, a live waveform, the live transcript as it is captured, and thumbnails of the screen captures taken during the session. Stop is always visible.

**1c — Processing.** A step checklist rather than an indeterminate spinner, so the user sees progress: transcribing, reviewing the page, writing variants, and the compliance check as its own explicit step.

**1d — Results.** Variant cards, each carrying an emotion tag, a predicted lift figure, and its own compliance badge.

---

## 6. Compliance badges

Every variant is badged — this is a regulated-industry product and an unbadged variant reads as an unreviewed one.

Clear variants show `Compliance: clear` in green (`--green-text` on `--green-bg`). Flagged variants show `Compliance: <short note>` in amber (`--amber-text` on `--amber-bg`), where the note names the specific concern (UDAAP language, a missing TILA/Reg Z disclosure, an unsubstantiated claim).

No emoji in badges. The label carries the meaning; color reinforces it.

---

## 7. Voice and copy

The user is a **marketer at a bank doing their job** — not a Persado buyer being sold to. Copy is plain, task-focused, and free of vendor pitch language.

Cut headline slogans: "Brief → High-Performance Copy" and "AI generates compliant language proven to convert" both come out in favour of plain task language ("Record your brief"). Ordinary marketing vocabulary — objective, product line, variant, CTA — is fine; it is the pitch phrasing in headings and subheads that goes.

Progress and process labels may name Persado methodology where it describes work the product genuinely performs ("Compliance check — UDAAP, Reg DD"). A progress step must never claim a stage that does not actually run; if the pipeline does not do it, the step does not appear.

**One exception, approved in review:** the start screen keeps a single Persado performance stat in its footer, set below a hairline divider and visually subordinate to the record button — "40% average engagement lift — Persado Motivation AI outperforms human copy 96% of the time." This is a credibility line for a product that has to justify rewriting a bank's copy, and it is confined to that one location. It does not reappear on any other screen, and no other surface carries a vendor claim.

Predicted-lift figures on variant cards are labelled as estimates, and the demo disclaimer appears exactly once per screen rather than repeated on every card.

Emoji do not appear anywhere in the UI.

---

## 8. Deprecated

Do not reintroduce any of the following: the purple `#5C2D91` → magenta `#E8388C` gradient header and buttons; the lowercase `p` between plain vertical bars as the toolbar mark; emoji in labels, badges, or buttons; uppercase mono micro-labels on every element; the large amber demo-disclaimer block and its per-card `(illustrative)` repetition; and the type-your-brief textarea fallback with its separate Generate button.
