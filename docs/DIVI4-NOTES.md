# Divi 4.27.7 (Divi Builder plugin) — verified facts the v4 adapter relies on

Source: `wp-content/plugins/divi-builder` 4.27.7, read 2026-10-21. `B\` = `includes/builder/`. Re-verify when the Divi version changes; `f2d doctor` checks the installed version against `capabilities/divi-4.27.json`.

## Page storage
* Builder page = `_et_pb_use_builder=on` (`B\core.php:4791`). The visual builder save also writes `_et_pb_built_for_post_type=page`, `_et_builder_version=VB|Divi|4.27.7`, `_et_pb_show_page_creation=off` (`B\functions.php:2366-2540`). We write the same set.
* Layout = shortcodes in `post_content`. Wrapper markup: `#et-boc .et-boc > #et_builder_outer_content > .et-l.et-l--post > .et_builder_inner_content.et_pb_gutters{N}` (`B\core.php:6560-6724`). Body classes `et_divi_builder`, `et-db`.
* CSS prefix `.et-db #et-boc .et-l` (`B\framework.php:3-16`). Module order classes `et_pb_text_0` etc.
* Page custom CSS: meta `_et_pb_custom_css`, emitted **unprefixed** before module styles in the unified static file (`B\functions.php:3850-3949`, `B\class-et-builder-element.php:1712`). We use it for the scoped page CSS, so the CSS stays editable in Divi's page settings.
* Block themes: no template takeover (`B\feature\gutenberg\BlockTemplates.php:93-161`), so the theme's header/footer wrap the content. The `f2d-bridge` plugin supplies a blank canvas template for generated pages.

## CSS cache
* Files: `wp-content/et-cache/{post_id}/et-core-unified-{post_id}.min.css` (+ `-deferred`, `-preview`), dynamic CSS `et-cache/{id}/et-divi-builder-dynamic-*.css`.
* Clear: `ET_Core_PageResource::remove_static_resources($post_id, 'all', true)`. It needs a user with `edit_posts` (WP-CLI: `wp_set_current_user`) — otherwise it **silently returns** (`core\components\PageResource.php:912-917`). Regeneration is lazy (next front-end view).

## Defaults that must be neutralised on generated elements
* Section `padding:4% 0; background:#fff` (≤980: `50px 0`). Row `width:80%; max-width:1080px; padding:2% 0; margin:auto` (≤980: `30px 0`).
* Columns `float:left` + gutter % widths at ≥981px only; ≤980 `width:100%; margin-bottom:30px`; ≤479 `width:100%!important`. **No native flex/grid** on rows/columns (only `make_equal` → `display:flex`).
* Module bottom margins by column type (gutters3: 2.75% for 4_4, …); last module 0. ≤980 `margin-bottom:30px`.
* Resets: `h1-h6 { line-height:1em; padding-bottom:10px; font-weight:500 }`, `p { padding-bottom:1em }` (last-of-type 0), `a { text-decoration:none!important }`, `img { max-width:100%; height:auto }`, `.et_pb_button { font-size:20px; padding:.3em 1em; border:2px solid; border-radius:3px }`.
* `custom_padding`/`custom_margin` on rows and section backgrounds are emitted with `!important` — so we never set a native value that differs from the scoped CSS.

## Attribute formats
* Responsive: `{f}_tablet`, `{f}_phone`, `{f}_last_edited="on|phone"`. Hover: `{f}__hover` + `{f}__hover_enabled="on|hover"`.
* Fonts: `{g}_font="Family|weight|italic|uppercase|underline|smallcaps|strike|lineColor|lineStyle"`, `{g}_font_size`, `{g}_line_height`, `{g}_letter_spacing`, `{g}_text_color`. A value equal to the field default emits **no CSS**. Text module groups: `text`, `header` (h1) … `header_6`; alignment is `text_orientation` (no `text_text_align`).
* Spacing: `custom_padding="t|r|b|l|false|false"`. Radius: `border_radii="on|tl|tr|br|bl"`. Borders `border_width_all`, `border_color_all`, per side `border_width_top`…
* Background: `background_color`, `use_background_color_gradient`, `background_color_gradient_stops="#a 0%|#b 100%"`, `background_color_gradient_direction`, `background_image`, `background_size`, `background_position`.
* Button: everything ignored unless `custom_button="on"`; `button_text_size`, `button_bg_color`, `button_border_width|color|radius`, `button_font`, `button_use_icon`.
* Column `type` / row `column_structure` from the fixed set (`4_4`, `1_2,1_2`, `1_3,2_3`, `1_4,1_4,1_4,1_4`, `1_5×5`, `1_6×6`, …).
* `module_class`, `module_id`, `admin_label`, `disabled_on="on|off|off"` (phone|tablet|desktop).
* Escaping: in attributes `"`→`%22`, `[`→`%91`, `]`→`%93`, `\`→`%92` (`B\functions.php:2056-2089`). In bodies `[`/`]` → `&#091;`/`&#093;`.
* Global colours: option `et_divi_builder_plugin['et_global_colors']` = `{gcid-x: {color, active:'yes'}}`; a module must also carry `global_colors_info="{%22gcid-x%22:%91%22attr%22%93}"` or the `gcid` is not replaced (`B\functions.php:13462-13502`).

## Content
* WordPress `wpautop` runs over the whole content before shortcodes: module bodies are emitted on **one line**, block-level tags only.
* Code module strips raw `\n`, `<p>`, `</p>` (`B\functions.php:10152-10168`); newlines must be `<!-- [et_pb_line_break_holder] -->`.

## Found by live QA on the test site (2026-10-21/22)
Each was caught by the QA suite on a real render; the fix is general (compiler/bridge), not page-specific.

| Symptom | Cause | Fix |
|---|---|---|
| Text in fragments rendered #111 | Divi base CSS `#et-boc .et-l p { color: inherit !important }` | colour via `--f2d-c` custom property on an inner `.f2d-tc` span |
| Page painted unstyled first, CLS 0.22 | Divi Critical CSS defers all page styles | `ET_Builder_Critical_CSS::instance()->disable()` on generated pages only (bridge) |
| Empty `<p>`/`<br>` inside fragments → one extra flex gap each | WordPress `wpautop` on `the_content` | bridge removes `wpautop` on generated pages; QA rule `structure.content-mangled` |
| `'` rendered as `’` | `wptexturize` | `run_wptexturize` false on generated pages |
| One-line headings wrapped | TT5 `text-wrap: balance` on headings resets the wrap mode of the inner `<h2>` | inner text elements inherit `white-space` / `text-wrap` from the module |
| Native button padding/icons ignored | `custom_button=on` emits `padding … !important` and `display:none !important` on `::before/::after`; only ETmodules font icons | SVG-icon buttons are HTML fragments; native `et_pb_button` for text-only buttons |
| Images never loaded (21) | WP adds `loading="lazy"`; images in horizontally clipped strips never intersect | `loading="eager"` for above-the-fold, off-frame and in-widget images |
| Decoration covered content / blocked clicks | layer row created its own stacking context with `pointer-events:none` | layer row `z-index:auto`; non-decorative layers `pointer-events:auto`; on phones the layer row joins the flow |
| Page selector never matched | Divi puts `.et-db` on `<body>` itself | `body.f2d-page.et-db #et-boc …` |
| Quarter/half columns forced to 50% on tablets (footer link groups stacked one per line) | Divi `.et_pb_gutters1.et_pb_row_4col > .et_pb_column.et_pb_column_1_4 { width: 50% }` at ≤980px (1 id + 6 classes) beat the column reset (1 id + 5) | reset `.et_pb_row.f2d-row > .et_pb_column.f2d-col.f2d-col` (7 classes); a box rendered as a column gets `.et_pb_column` + its class ×5 (8), so the layout engine's own sizing wins at every breakpoint |
| Negative auto-layout spacing lost (photo meant to overlap a colour panel sat beside it) | the module reset `.et_pb_column .et_pb_module.f2d-el { margin: 0 }` (1 id + 5 classes) beat the box's own `margin-left: -487px` (1 id + 4) | the reset only cancels Divi's default (`margin-bottom: 0`); boxes keep their own margins |
| Design-width QA measured at 1935px instead of 1920px | Playwright's full-page screenshot makes the viewport page-tall, the classic scrollbar disappears and does not always come back | `capture` restores the viewport after screenshots and verifies `clientWidth` before any check |
| Sticky header scrolled away | the page frame's own clip (`overflow: hidden` from Figma) + `overflow-x: clip` left the inner content wrapper with `overflow-y: hidden`, a scroll container | the page root clips sideways only (`overflow-x: clip`); the header is its own `et_pb_section` (`position: sticky`), whose parent is the whole page |
| Compact header collapsed to 0px | an overlay header lives in the section's absolute layer row; it joins the flow at the menu tier (1200), the layer row only did at 980/767 | the layer row joins the flow from the widest ladder tier at which one of its layers does |
| Icons centred in their row on tablets/phones | Divi `.et_pb_image_N { margin-left: auto }` at ≤980px (1 id + 3 classes) | `.et_pb_image.f2d-el { margin-left: 0; margin-right: 0 }` (1 id + 4); a box's own margins print later at the same weight and still win |
| Image as narrow as its capped height allows on tablets/phones | Divi `.et_pb_image_N .et_pb_image_wrap img { width: auto }` at ≤980px, same weight as the image reset and printed later | reset also matched through the wrap (`.et_pb_image.f2d-el .et_pb_image_wrap img`, one class stronger) |

## Visual Builder (verified 2026-10-28 on 4.27.7, `frontend-builder/build/bundle.css` + the per-module `<style class="et-fb-custom-css-output">`)
The builder renders the same shortcodes inside `#et-fb-app > #et_pb_root > .et-fb-post-content`, in the
`et-fb-app-frame` iframe, with its own CSS and markup on top. Without the compiler's editor-only rules
(`/* Visual Builder parity */` block, every selector under `#et-fb-app` or `html.et-fb-preview--*`) the
page broke in the editor while the front end was right. `f2d check` measures it (`editor.parity@*`).

| Builder difference | Effect on a generated page | Fix (compiler) |
|---|---|---|
| every module `position: relative !important; top: 0; left: 0` (1 id + 3 classes) | absolutely placed elements fell into the flow; right/bottom-anchored ones moved | per tier, the box's own `position` with `!important` (2 ids, editor only), `top/left` restored |
| `#et-fb-app .et_pb_module, .et_pb_column { position: relative }`, columns `z-index: 9` (2 ids) | decoration layers painted over content (white stripes) | columns get their own `z-index` (front default 2), decoration columns `position: static`, all one class stronger |
| `#et-fb-app .et_pb_column--collapsed .et_pb_module { min-height: 30px }` | 2px connector lines 30px tall | module `min-height` restored (box value, else `auto`) |
| `.et_pb_column--collapsed::after { content: "." }` — a pass-through column (`display: contents`) is always "collapsed" | the pseudo-element became an extra flex item of the row (`space-between` rows shifted) | `#et-fb-app .et_pb_column.f2d-col::after { display: none }` |
| `<div data-shortcode-id>` inside every `.et_pb_text_inner` | broke the `display: contents` chain: fragments stopped being flex items (cards wrapped) | that wrapper is `display: contents` |
| `wpautop` over module HTML in the editor (and written by a builder **save**): class-less `<p>` around inline elements, `<br>` between elements | extra flex items, extra lines | front and editor: class-less `<p>` in our modules `display: contents`; `<br>` directly in a div/link/class-less `<p>` hidden (every tag we emit has a class; our own breaks sit inside text tags) |
| `#et-fb-app` is the only child of the page frame (a content-sized flex item) | sections laid out on a ~1700px canvas at narrower widths | `#et-fb-app`, `#et_pb_root` stretch; `.et-fb-post-content` gets the frame's flex layout |
| tablet / phone previews: the admin bar is outside the preview frame (no html margin) but `--wp-admin--admin-bar--height` stays 32/46px | sticky header pushed down | the variable is 0 in those previews |

A builder save also writes its defaults into every module (`_builder_version`, animation, background and
alignment attributes) and drops `show_bottom_space`, `force_fullwidth`, `make_equal`: verified to leave the
front end identical (every element, 1920 / 1024 / 390).
