/**
 * Staff OCR workbench (spec §7), evolved from Codex's dependency-free draft.
 * Runs under a strict CSP: one nonce'd inline script, no inline handlers, no eval, no external scripts.
 * Every piece of document / OCR text enters the DOM through textContent (never innerHTML).
 */
const HTML_ESCAPES: Readonly<Record<string, string>> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" };
const escapeHtml = (value: string): string => value.replace(/[&<>"']/g, (character) => HTML_ESCAPES[character] ?? character);

const FONTS = "https://fonts.googleapis.com/css2?family=Geist:wght@400;500;600&family=Geist+Mono:wght@400;500;600&family=Noto+Sans+Thai:wght@400;500;600&display=swap";

const STYLE = String.raw`
:root{color-scheme:light;--canvas:#FAFAFA;--card:#FFFFFF;--fill:#F2F2F2;--line:#EBEBEB;--line2:#D9D9D9;--fg:#171717;--fg2:#4D4D4D;--fg3:#666666;--fg4:#7D7D7D;--fg5:#A8A8A8;--ring:0 0 0 1px rgba(0,0,0,.08),0 2px 2px rgba(0,0,0,.04),0 0 0 1px #FAFAFA;--float:0 0 0 1px rgba(0,0,0,.08),0 8px 30px rgba(0,0,0,.12);--red:#E5484D;--red-ink:#CD2B31;--red-bg:#FEECEE;--amber:#F5A524;--amber-bg:#FFF4D6;--amber-row:#FFFAEB;--amber-line:#F3D58A;--teal:#12A594;--teal-bg:#E6F9F5;--blue:#52AEFF;--blue-bg:#EBF5FF;--ease:cubic-bezier(.4,0,.2,1);--sans:"Geist","Noto Sans Thai","IBM Plex Sans Thai",system-ui,-apple-system,"Segoe UI",sans-serif;--mono:"Geist Mono",ui-monospace,SFMono-Regular,Menlo,Consolas,"Noto Sans Thai",monospace}
*,*::before,*::after{box-sizing:border-box}
[hidden]{display:none!important}
html{-webkit-text-size-adjust:100%}
body{margin:0;min-height:100vh;background:var(--canvas);color:var(--fg);font:400 14px/1.6 var(--sans);-webkit-font-smoothing:antialiased}
body.modal-open{overflow:hidden}
h1,h2,h3,p{margin:0}
button,input,select{font:inherit;color:inherit}
:focus-visible{outline:2px solid var(--fg);outline-offset:2px}
.sr-only{position:absolute!important;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}
.skip{position:absolute;left:16px;top:-48px;z-index:50;padding:8px 16px;border-radius:9999px;background:var(--fg);color:#fff;text-decoration:none;transition:top .15s var(--ease)}
.skip:focus{top:8px}
.mono{font-family:var(--mono)}
.num{font-variant-numeric:tabular-nums}
.sub{font-size:12px;line-height:1.5;color:var(--fg3)}
.err{color:var(--red-ink)}
.card{background:var(--card);border-radius:8px;box-shadow:var(--ring)}
.acts{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;min-height:40px;padding:0 16px;border:0;border-radius:9999px;background:var(--card);color:var(--fg);box-shadow:0 0 0 1px var(--line);font:500 14px/1 var(--sans);text-decoration:none;white-space:nowrap;cursor:pointer;transition:background-color .15s var(--ease),box-shadow .15s var(--ease),color .15s var(--ease),opacity .15s var(--ease)}
.btn:hover{background:var(--fill);box-shadow:0 0 0 1px var(--line2)}
.btn.primary{background:var(--fg);color:#FFFFFF;box-shadow:none}
.btn.primary:hover{background:#383838}
.btn.ghost{background:transparent;box-shadow:none}
.btn.ghost:hover{background:var(--fill)}
.btn.danger{color:var(--red-ink)}
.btn.sm{min-height:32px;padding:0 12px;font-size:13px}
.btn:disabled{opacity:.45;cursor:not-allowed}
.btn.primary:disabled:hover{background:var(--fg)}
@media (pointer:coarse){.btn{min-height:44px}.btn.sm{min-height:40px}}
input[type=text],input[type=search],select{width:100%;min-height:40px;padding:8px 12px;border:0;border-radius:6px;background:var(--card);color:var(--fg);box-shadow:0 0 0 1px var(--line2);font:400 16px/1.4 var(--sans);transition:box-shadow .15s var(--ease),background-color .15s var(--ease)}
input[type=text]:hover,input[type=search]:hover,select:hover{box-shadow:0 0 0 1px var(--fg5)}
input[type=text]:focus-visible,input[type=search]:focus-visible,select:focus-visible{outline:none;box-shadow:0 0 0 2px var(--fg)}
input[readonly]{background:var(--fill);color:var(--fg2)}
input::placeholder{color:var(--fg5)}
select{appearance:none;-webkit-appearance:none;padding-right:36px;background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 12 12'%3E%3Cpath d='M3 4.5l3 3 3-3' fill='none' stroke='%23666666' stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E");background-repeat:no-repeat;background-position:right 12px center;cursor:pointer}
.top{display:flex;align-items:center;justify-content:space-between;gap:16px;height:56px;padding:0 24px;background:var(--canvas);box-shadow:0 1px 0 var(--line)}
.brand{display:flex;align-items:center;gap:10px;min-width:0;font-size:14px}
.brand strong{font-weight:600;letter-spacing:-.02em}
.brand .mark{flex:none;width:18px;height:18px;border-radius:4px;background:var(--fg)}
.brand .crumb{color:var(--fg5)}
.brand .here{color:var(--fg3);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.conn{display:inline-flex;align-items:center;gap:8px;height:28px;padding:0 10px;border-radius:4px;background:var(--card);box-shadow:0 0 0 1px var(--line);font-size:12px;color:var(--fg2);white-space:nowrap}
.dot{flex:none;width:6px;height:6px;border-radius:50%;background:var(--fg5)}
.conn.c-ok .dot{background:var(--teal)}
.conn.c-error .dot{background:var(--red)}
.conn.c-wait .dot,.b-processing .dot,.d-pending .dot,.d-retrying .dot{animation:pulse 1.2s var(--ease) infinite}
@keyframes pulse{50%{opacity:.25}}
main{padding:40px 24px 96px}
.hero{display:flex;align-items:flex-end;justify-content:space-between;gap:24px;margin-bottom:24px}
.hero h1{font-size:32px;line-height:1.25;font-weight:600;letter-spacing:-.04em}
.hero .lede{margin-top:6px;font-size:14px;color:var(--fg3)}
.h-sm{font-size:14px;line-height:1.5;font-weight:600;letter-spacing:-.01em}
.drop{padding:8px;margin-bottom:24px}
.drop-inner{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:20px 20px;border-radius:6px;border:1px dashed var(--line2);transition:background-color .15s var(--ease),border-color .15s var(--ease)}
.drop.drag .drop-inner{background:var(--fill);border-color:var(--fg)}
.drop-copy{display:flex;align-items:center;gap:14px;min-width:0}
.drop-icon{flex:none;display:grid;place-items:center;width:40px;height:40px;border-radius:50%;background:var(--fill);color:var(--fg2);font:500 20px/1 var(--mono)}
.uploads{padding:12px 12px 4px}
.up-bar{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;padding:4px 0 10px}
.up-list{max-height:288px;overflow:auto;border-radius:6px;box-shadow:0 0 0 1px var(--line)}
.up-row{display:grid;grid-template-columns:minmax(0,2fr) 72px minmax(0,1.6fr) minmax(80px,1fr) auto;align-items:center;gap:12px;min-height:44px;padding:6px 12px;border-bottom:1px solid var(--line);font-size:13px}
.up-row:last-child{border-bottom:0}
.up-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.up-size{text-align:right}
.up-state{color:var(--fg2)}
.up-state.s-done{color:var(--fg3)}
.up-state.s-done::before{content:"✓ ";color:var(--teal)}
.up-state.s-failed,.up-state.s-rejected{color:var(--red-ink)}
.bar{display:block;height:4px;border-radius:9999px;background:var(--fill);overflow:hidden}
.fill{display:block;height:100%;width:0;background:var(--fg);transition:width .15s var(--ease)}
.up-act{display:flex;justify-content:flex-end;min-width:0}
.batch{padding:20px 24px;margin-bottom:40px}
.batch-head{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;flex-wrap:wrap;margin-bottom:16px}
.stack{display:flex;height:8px;border-radius:9999px;background:var(--fill);overflow:hidden;margin-bottom:16px}
.stack span{display:block;height:100%;transition:width .15s var(--ease)}
.seg-confirmed{background:var(--teal)}.seg-succeeded{background:var(--blue)}.seg-review{background:var(--amber)}.seg-failed{background:var(--red)}.seg-processing{background:var(--fg4)}.seg-queued{background:var(--line2)}
.stats{display:grid;grid-template-columns:repeat(9,minmax(0,1fr));gap:16px;margin:0}
.stat{min-width:0}
.stat dt{display:flex;align-items:center;gap:6px;font-size:12px;color:var(--fg3);white-space:nowrap}
.stat dd{margin:2px 0 0;font:600 24px/1.3 var(--mono);letter-spacing:-.04em;font-variant-numeric:tabular-nums}
.stat .dot.k-confirmed{background:var(--teal)}.stat .dot.k-succeeded{background:var(--blue)}.stat .dot.k-review{background:var(--amber)}.stat .dot.k-failed{background:var(--red)}.stat .dot.k-processing{background:var(--fg4)}.stat .dot.k-queued{background:var(--line2)}
.docs-head{display:flex;align-items:baseline;justify-content:space-between;gap:12px;margin-bottom:12px}
.docs-head h2:focus{outline:none}
.toolbar{display:flex;align-items:flex-end;gap:12px;flex-wrap:wrap;margin-bottom:16px}
.fld{display:flex;flex-direction:column;gap:4px;min-width:180px}
.fld.grow{flex:1 1 320px;max-width:520px}
.fld-l{font-size:12px;font-weight:500;color:var(--fg3)}
.table-card{overflow:hidden}
.scroll{overflow:auto;max-height:max(420px,calc(100vh - 160px));overscroll-behavior:contain}
.scroll:focus-visible{outline-offset:-2px}
table{width:100%;min-width:1280px;border-collapse:separate;border-spacing:0;font-size:14px}
th{position:sticky;top:0;z-index:2;padding:10px 12px;background:var(--canvas);color:var(--fg3);font-size:12px;font-weight:500;text-align:left;white-space:nowrap;box-shadow:inset 0 -1px 0 var(--line)}
td{padding:12px;vertical-align:top;background:var(--card);border-bottom:1px solid var(--line);transition:background-color .15s var(--ease)}
tbody tr:last-child td{border-bottom:0}
th:first-child,td:first-child{position:sticky;left:0;z-index:1;width:220px;min-width:200px;max-width:260px;box-shadow:inset -1px 0 0 var(--line)}
th:first-child{z-index:3;box-shadow:inset -1px 0 0 var(--line),inset 0 -1px 0 var(--line)}
tbody tr:hover td{background:#F7F7F7}
tr.r-review td{background:var(--amber-row)}
tbody tr.r-review:hover td{background:#FFF5DB}
tr.r-review td:first-child{box-shadow:inset 3px 0 0 var(--amber),inset -1px 0 0 var(--line)}
.fname{font:500 13px/1.45 var(--mono);overflow-wrap:anywhere}
.link{display:block;max-width:100%;padding:0;border:0;background:none;color:inherit;text-align:left;cursor:pointer;text-decoration:underline;text-decoration-color:transparent;text-underline-offset:3px;transition:text-decoration-color .15s var(--ease)}
.link:hover{text-decoration-color:currentColor}
.m-only{display:none!important}
.c-name{min-width:140px}
.c-treat{min-width:160px}
.c-dur{min-width:96px}
.c-status{min-width:160px}
.c-conf{min-width:88px}
.c-act{min-width:190px}
.lines{display:flex;flex-direction:column}
.line{line-height:22px;white-space:nowrap}
.none{color:var(--fg5)}
.badge{display:inline-flex;align-items:center;gap:6px;height:24px;padding:0 8px;border-radius:4px;background:var(--fill);color:var(--fg);font-size:12px;font-weight:500;line-height:1;white-space:nowrap}
.b-review{background:var(--amber-bg)}.b-review .dot{background:var(--amber)}
.b-failed{background:var(--red-bg)}.b-failed .dot{background:var(--red)}
.b-confirmed{background:var(--teal-bg)}.b-confirmed .dot{background:var(--teal)}
.b-succeeded{background:var(--blue-bg)}.b-succeeded .dot{background:var(--blue)}
.b-processing .dot{background:var(--fg2)}
.b-split .dot{background:var(--fg4)}
.pageno{display:inline-block;margin-top:2px;font:500 12px/1.5 var(--mono);color:var(--fg2)}
.filter-chip{display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin:-4px 0 16px;padding:8px 8px 8px 14px;border-radius:8px;background:var(--card);box-shadow:var(--ring);font-size:13px;color:var(--fg2)}
.filter-chip strong{color:var(--fg);font-weight:500;overflow-wrap:anywhere}
.d-delivered .dot{background:var(--teal)}.d-failed .dot{background:var(--red)}.d-failed{background:var(--red-bg)}
.c-status .sub{margin-top:6px;max-width:200px;display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:2;overflow:hidden;overflow-wrap:anywhere}
.empty{padding:48px 24px;text-align:center}
.empty .empty-title{font-weight:600;margin-bottom:4px}
.empty .btn{margin-top:16px}
.pager{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-top:16px;flex-wrap:wrap}
.notice{position:fixed;right:24px;bottom:24px;z-index:30;display:flex;align-items:flex-start;gap:10px;max-width:min(480px,calc(100vw - 32px));padding:12px 8px 12px 16px;border-radius:8px;background:var(--card);box-shadow:var(--float);font-size:14px}
.notice .dot{margin-top:8px;background:var(--teal)}
.notice.is-error{background:#FFF8F8;box-shadow:0 0 0 1px #F9C6C9,0 8px 30px rgba(0,0,0,.12)}
.notice.is-error .dot{background:var(--red)}
.notice-text{flex:1;padding-top:3px}
dialog.drawer{position:fixed;inset:0 0 0 auto;width:min(1240px,100vw);max-width:100vw;height:100vh;height:100dvh;max-height:100vh;max-height:100dvh;margin:0;padding:0;border:0;background:var(--canvas);color:var(--fg);box-shadow:var(--float);overflow:hidden}
dialog.drawer[open]{animation:slide .2s var(--ease)}
@keyframes slide{from{transform:translateX(32px);opacity:0}}
dialog.drawer::backdrop{background:rgba(0,0,0,.4)}
.d-shell{position:relative;display:flex;flex-direction:column;height:100%}
.d-head{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;padding:16px 24px;background:var(--card);box-shadow:0 1px 0 var(--line)}
.d-titles{min-width:0}
.eyebrow{font-size:12px;font-weight:500;color:var(--fg3)}
.d-titles h2{margin:2px 0 8px;font:600 20px/1.35 var(--mono);letter-spacing:-.04em;overflow-wrap:anywhere}
.d-status{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.d-alert{display:flex;align-items:center;gap:12px;flex-wrap:wrap;padding:10px 24px;background:var(--card);box-shadow:0 1px 0 var(--line);font-size:14px}
.d-alert.is-error{background:var(--red-bg);color:#7A1418}
.d-alert.is-ok{background:var(--teal-bg)}
.d-alert-text{flex:1 1 280px}
.d-body{flex:1;min-height:0;display:grid;grid-template-columns:minmax(0,5fr) minmax(0,6fr)}
.d-preview{min-height:0;display:flex;flex-direction:column;background:var(--fill);box-shadow:inset -1px 0 0 var(--line)}
.p-tools{display:flex;align-items:center;gap:6px;flex-wrap:wrap;padding:12px 16px}
.p-tools .z-level{min-width:48px;text-align:center;font:500 12px/1 var(--mono);color:var(--fg3)}
.p-tools .spacer{flex:1}
.p-content{flex:1;min-height:0;overflow:auto;padding:0 16px 16px}
.p-content img{display:block;width:100%;max-width:none;height:auto;border-radius:6px;background:#FFFFFF;box-shadow:var(--ring)}
.p-content iframe{display:block;width:100%;height:100%;min-height:60vh;border:0;border-radius:6px;background:#FFFFFF;box-shadow:var(--ring)}
.p-note{padding:24px 4px}
.d-editor{min-height:0;overflow:auto;padding:20px 24px 40px}
.d-foot{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:12px 24px;background:var(--card);box-shadow:0 -1px 0 var(--line)}
.d-foot .draft{font-size:13px;color:var(--fg3)}
.d-foot .draft.is-dirty{color:var(--fg);font-weight:500}
.d-foot .draft.is-dirty::before{content:"● ";color:var(--amber)}
.panel{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;margin-bottom:16px;padding:14px 16px;border-radius:8px;background:var(--card);box-shadow:var(--ring)}
.panel.needs{background:var(--amber-row);box-shadow:0 0 0 1px var(--amber-line)}
.panel p{flex:1 1 240px}
.group{margin:0 0 16px;padding:16px 20px 20px;border-radius:8px;background:var(--card);box-shadow:var(--ring)}
.group-title{margin:0 0 8px;font-size:14px;font-weight:600;letter-spacing:-.01em}
.field{margin:0 -12px;padding:10px 12px;border-radius:6px;transition:background-color .15s var(--ease)}
.field.needs,.t-item.needs,.chip.needs{background:var(--amber-row);box-shadow:inset 3px 0 0 var(--amber)}
.f-head{display:flex;align-items:center;gap:8px;min-height:22px;margin-bottom:6px}
.f-label{font-size:13px;font-weight:500;color:var(--fg2)}
.flag{display:inline-flex;align-items:center;gap:4px;height:20px;padding:0 6px;border-radius:4px;background:var(--amber-bg);color:var(--fg);font-size:12px;font-weight:500;white-space:nowrap}
.flag::before{content:"!";display:inline-grid;place-items:center;width:14px;height:14px;border-radius:50%;background:var(--fg);color:#FFFFFF;font:700 10px/1 var(--sans)}
.f-meta{display:flex;flex-wrap:wrap;gap:2px 12px;margin-top:6px;font-size:12px;line-height:1.5;color:var(--fg3)}
.f-meta q{color:var(--fg);font-family:var(--mono);overflow-wrap:anywhere}
.edited{display:none;color:var(--fg);font-weight:500}
.is-edited>.f-meta .edited,.is-edited .t-meta .edited{display:inline}
.missing{font-size:13px;color:var(--fg4)}
.chips{list-style:none;margin:0 0 8px;padding:0;display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:8px}
.chip{display:grid;grid-template-columns:minmax(0,1fr) auto;align-items:center;gap:6px;padding:6px;border-radius:6px;background:var(--canvas);box-shadow:0 0 0 1px var(--line)}
.chip.needs{box-shadow:inset 3px 0 0 var(--amber),0 0 0 1px var(--amber-line)}
.chip.is-edited{box-shadow:0 0 0 1px var(--fg4)}
.chip input[type=text]{min-height:36px;padding:6px 10px}
.chip .f-meta{grid-column:1/-1;margin:0 4px 2px}
.chip-empty{grid-column:1/-1;font-size:13px;color:var(--fg4)}
.t-item{margin:0 0 8px;padding:12px;border-radius:6px;background:var(--canvas);box-shadow:0 0 0 1px var(--line)}
.t-item.needs{box-shadow:inset 3px 0 0 var(--amber),0 0 0 1px var(--amber-line)}
.t-item.is-edited{box-shadow:0 0 0 1px var(--fg4)}
.t-head{display:flex;align-items:center;gap:8px;margin-bottom:8px}
.t-head strong{font-size:13px;font-weight:600}
.t-head .btn{margin-left:auto}
.t-grid{display:grid;grid-template-columns:minmax(0,2fr) minmax(0,1fr);gap:12px}
.t-grid label{display:flex;flex-direction:column;gap:4px;font-size:12px;font-weight:500;color:var(--fg3)}
.t-meta{margin-top:8px}
.raw-json{margin-top:8px;border-radius:8px;background:var(--card);box-shadow:var(--ring)}
.raw-json summary{padding:12px 16px;cursor:pointer;font-size:13px;font-weight:500;color:var(--fg2);border-radius:8px}
.raw-json pre{margin:0;max-height:420px;overflow:auto;padding:12px 16px 16px;font:12px/1.6 var(--mono);white-space:pre-wrap;overflow-wrap:anywhere;box-shadow:inset 0 1px 0 var(--line)}
.ask{position:absolute;inset:0;z-index:10;display:grid;place-items:center;padding:16px;background:rgba(250,250,250,.75);-webkit-backdrop-filter:blur(2px);backdrop-filter:blur(2px)}
.ask-card{width:min(440px,100%);padding:24px;border-radius:12px;background:var(--card);box-shadow:var(--float)}
.ask-card h3{font-size:20px;line-height:1.35;font-weight:600;letter-spacing:-.02em}
.ask-card p{margin:8px 0 20px;color:var(--fg2)}
.ask-card .acts{justify-content:flex-end}
/* Login, password, users and confirm dialogs. The auth backdrop is the opaque canvas: it hides the page (and an open
   drawer) without closing either, so the auth dialog is always the top-most modal and everything under it is inert. */
dialog.modal{width:100%;max-width:none;height:100%;max-height:none;margin:0;padding:0;border:0;background:transparent;color:var(--fg);overflow:auto;overscroll-behavior:contain}
dialog.modal::backdrop{background:rgba(250,250,250,.92)}
dialog.modal.auth::backdrop{background:var(--canvas)}
.m-wrap{min-height:100%;display:grid;place-items:center;padding:32px 16px}
/* min-width:0 is what makes .x-scroll the scroll container: without it a grid item's automatic minimum size is the
   min-content of the nowrap users table, so the whole card grew past the viewport and the admin had to pan sideways. */
.m-card{width:min(440px,100%);min-width:0;padding:24px;border-radius:12px;background:var(--card);box-shadow:var(--float)}
.m-card.wide{width:min(1060px,100%)}
.m-card h1{font-size:32px;line-height:1.25;font-weight:600;letter-spacing:-.04em}
.m-card h2{font-size:20px;line-height:1.35;font-weight:600;letter-spacing:-.02em}
.m-card>p{margin-top:8px;color:var(--fg2)}
.m-head{display:flex;align-items:center;justify-content:space-between;gap:12px}
.m-card .fld{margin-top:14px;min-width:0}
.m-card .acts{margin-top:20px;justify-content:flex-end}
.m-card .err:empty{display:none}
.m-card .err{margin-top:12px;font-size:13px}
.m-card.auth-card{width:min(400px,100%)}
.auth-card .brand{margin-bottom:24px}
.auth-card h1{margin-bottom:4px}
.btn.wide{width:100%;margin-top:20px}
.pw-wrap{display:flex;align-items:center;gap:8px;min-width:0}
.pw-wrap input{flex:1;min-width:0}
input[type=password],input[type=date]{width:100%;min-height:40px;padding:8px 12px;border:0;border-radius:6px;background:var(--card);color:var(--fg);box-shadow:0 0 0 1px var(--line2);font:400 16px/1.4 var(--sans);transition:box-shadow .15s var(--ease)}
input[type=password]:hover,input[type=date]:hover{box-shadow:0 0 0 1px var(--fg5)}
input[type=password]:focus-visible,input[type=date]:focus-visible{outline:none;box-shadow:0 0 0 2px var(--fg)}
input[type=checkbox]{flex:none;width:18px;height:18px;margin:0;accent-color:var(--fg)}
.chk{display:flex;align-items:center;gap:8px;margin-top:14px;font-size:14px}
.x-scroll{overflow:auto;max-height:44vh;margin-top:16px;border-radius:8px;box-shadow:0 0 0 1px var(--line)}
/* The document table is 1280px wide with a sticky first column; inside a dialog the table is ordinary again. */
.modal table,.x-scroll table{min-width:0;font-size:13px}
.modal th,.modal td{white-space:nowrap;padding:8px 12px}
.modal td{vertical-align:middle}
.modal th:first-child,.modal td:first-child{position:static;z-index:auto;width:auto;min-width:0;max-width:none;box-shadow:inset 0 -1px 0 var(--line)}
.modal tbody tr:last-child td:first-child{box-shadow:none}
.temp{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;flex-wrap:wrap;margin-top:16px;padding:12px 16px;border-radius:8px;background:var(--amber-row);box-shadow:0 0 0 1px var(--amber-line)}
#temp-pass{display:inline-block;margin:4px 0;font:600 18px/1.4 var(--mono);letter-spacing:.04em;overflow-wrap:anywhere}
.badge.u-active{background:var(--teal-bg)}.badge.u-active .dot{background:var(--teal)}
.badge.u-disabled{background:var(--fill)}.badge.u-disabled .dot{background:var(--fg4)}
.badge.u-locked{background:var(--red-bg)}.badge.u-locked .dot{background:var(--red)}
.badge.u-must_change{background:var(--amber-bg)}.badge.u-must_change .dot{background:var(--amber)}
.top-right{display:flex;align-items:center;gap:12px;min-width:0}
.me{display:flex;align-items:center;gap:8px;min-width:0}
.me-name{max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:13px;font-weight:500}
#checking{display:none;position:fixed;inset:0;z-index:60;place-items:center;padding:24px;background:var(--canvas);color:var(--fg3);text-align:center}
body[data-auth="checking"] #checking{display:grid}
body[data-auth="checking"] main,body[data-auth="checking"] .top-right{visibility:hidden}
body[data-auth="out"] #me,body[data-auth="out"] #me-open{display:none!important}
@media (max-width:1180px){.stats{grid-template-columns:repeat(5,minmax(0,1fr))}}
@media (max-width:860px){.d-body{display:block;overflow:auto}.d-preview{height:42vh;height:42dvh;box-shadow:inset 0 -1px 0 var(--line)}.d-editor{overflow:visible;padding:16px}.d-head{padding:12px 16px}.d-alert{padding:10px 16px}.d-foot{flex-direction:column;align-items:stretch;gap:8px;padding:10px 16px}.d-foot .draft{font-size:12px}.d-foot .draft:empty{display:none}.d-foot .acts{flex-wrap:wrap}.d-foot #d-cancel{order:1}.d-foot #d-save{order:2;flex:1}.d-foot #d-next{order:3;flex:1 1 100%}.p-content iframe{min-height:0}}
@media (max-width:720px){main{padding:24px 16px 80px}.top{padding:0 16px}.brand .crumb,.brand .here{display:none}.hero{flex-direction:column;align-items:stretch;gap:16px}.hero h1{font-size:32px}.drop-inner{flex-direction:column;align-items:stretch;padding:16px}.up-row{grid-template-columns:minmax(0,1fr) auto;grid-template-areas:"name act" "state act" "bar bar";row-gap:4px;padding:8px 12px}.up-name{grid-area:name}.up-size{display:none}.up-state{grid-area:state}.bar{grid-area:bar}.up-act{grid-area:act}.batch{padding:16px}.stats{grid-template-columns:repeat(3,minmax(0,1fr));gap:12px}.stat dd{font-size:20px}.fld,.fld.grow{flex:1 1 100%;max-width:none;min-width:0}.toolbar .btn{flex:1}.t-grid{grid-template-columns:1fr}.notice{left:16px;right:16px;bottom:16px}th:first-child,td:first-child{width:168px;min-width:168px;max-width:168px}.c-file .m-only{display:inline-flex!important;margin-top:6px}
/* The 56px header must fit 375px: the brand, the connection chip and the one #me-open pill. The pill carries the whole
   display name, and .btn is nowrap, so without a cap a long Thai name gives the page a horizontal scrollbar. The
   connection text keeps its live region (it is only taken out of the flow), so its state is still announced. */
.me-name{max-width:min(30vw,120px)}
#conn-text{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);border:0}}
@media (prefers-reduced-motion:reduce){*,*::before,*::after{animation-duration:.01ms!important;animation-iteration-count:1!important;transition-duration:.01ms!important;scroll-behavior:auto!important}}
`;

const BODY = String.raw`<a class="skip" href="#docs-title">ข้ามไปที่รายการเอกสาร</a>
<header class="top"><div class="brand"><span class="mark" aria-hidden="true"></span><strong>INNOVERA</strong><span class="crumb" aria-hidden="true">/</span><span class="here">เอกสาร OCR</span></div><div class="top-right"><div id="conn" class="conn c-wait" role="status"><span class="dot" aria-hidden="true"></span><span id="conn-text">กำลังเชื่อมต่อ…</span></div><div id="me" class="me" hidden><span id="me-name" class="me-name"></span><span id="me-role" class="badge"></span><button id="users-open" class="btn sm" type="button" hidden>ผู้ใช้งาน</button><button id="pw-open" class="btn sm" type="button">เปลี่ยนรหัสผ่าน</button><button id="logout" class="btn sm ghost" type="button">ออกจากระบบ</button></div><button id="me-open" class="btn sm" type="button" hidden><span id="me-open-name" class="me-name"></span></button></div></header>
<main>
<section class="hero"><div><h1>เอกสาร OCR</h1><p class="lede">อัปโหลดแบบฟอร์มลูกค้า ตรวจทานผลการอ่าน และยืนยันข้อมูลในที่เดียว</p></div><button id="pick" class="btn primary" type="button">อัปโหลดเอกสาร</button></section>
<section id="drop" class="drop card" aria-labelledby="drop-title"><div class="drop-inner"><div class="drop-copy"><span class="drop-icon" aria-hidden="true">+</span><div><h2 id="drop-title" class="h-sm">ลากไฟล์มาวางที่นี่ หรือเลือกไฟล์จากเครื่อง</h2><p class="sub">PNG, JPG, WebP หรือ PDF · ครั้งละไม่เกิน 100 ไฟล์ · PDF หลายหน้าจะถูกแยกเป็นหนึ่งแถวต่อหน้า · ระบบอ่านแต่ละไฟล์แยกกัน ไฟล์ที่ผิดพลาดไม่กระทบไฟล์อื่น</p></div></div><button id="pick2" class="btn" type="button">เลือกไฟล์</button><input id="files" class="sr-only" type="file" multiple accept="image/png,image/jpeg,image/webp,application/pdf,.png,.jpg,.jpeg,.webp,.pdf" tabindex="-1" aria-hidden="true"></div>
<div id="uploads" class="uploads" hidden><div class="up-bar"><span id="up-summary" class="sub" role="status"></span><div class="acts"><button id="up-retry" class="btn sm" type="button" hidden>ลองใหม่ทั้งหมด</button><button id="up-clear" class="btn sm ghost" type="button" hidden>ล้างรายการที่เสร็จแล้ว</button></div></div><div id="up-list" class="up-list" aria-label="สถานะการอัปโหลดแต่ละไฟล์"></div></div>
</section>
<section id="batch" class="batch card" aria-labelledby="batch-title" hidden><div class="batch-head"><div><h2 id="batch-title" class="h-sm">ชุดอัปโหลดล่าสุด</h2><p id="batch-meta" class="sub"></p></div><button id="batch-view" class="btn sm" type="button">ดูเอกสารในชุดนี้</button></div><div id="batch-bar" class="stack" role="img"></div><dl id="batch-stats" class="stats"></dl></section>
<section aria-labelledby="docs-title">
<div class="docs-head"><h2 id="docs-title" class="h-sm" tabindex="-1">รายการเอกสาร</h2><span id="updated" class="sub mono" aria-live="off"></span></div>
<div class="toolbar"><label class="fld grow"><span class="fld-l">ค้นหา</span><input id="q" type="search" autocomplete="off" maxlength="100" placeholder="ชื่อไฟล์ ชื่อลูกค้า ชื่อพนักงาน หรือเลขที่ฟอร์ม"></label><label class="fld"><span class="fld-l">สถานะ</span><select id="status"><option value="">ทุกสถานะ</option><option value="review">รอตรวจสอบ</option><option value="failed">ไม่สำเร็จ</option><option value="processing">กำลังอ่าน</option><option value="queued">รอคิว</option><option value="succeeded">อ่านสำเร็จ (ยังไม่ยืนยัน)</option><option value="confirmed">ยืนยันแล้ว</option></select></label><label class="fld"><span class="fld-l">ชุดอัปโหลด</span><select id="batch-filter"><option value="">ทุกชุดอัปโหลด</option></select></label><button id="reload" class="btn" type="button">รีเฟรช</button></div>
<div id="parent-chip" class="filter-chip" role="status" hidden><span id="parent-chip-text"></span><button id="parent-clear" class="btn sm ghost" type="button">แสดงเอกสารทั้งหมด</button></div>
<div class="card table-card"><div id="scroll" class="scroll" tabindex="0" role="region" aria-labelledby="docs-title" aria-describedby="scroll-hint"><table><caption class="sr-only">หนึ่งแถวต่อหนึ่งเอกสาร</caption><thead><tr><th scope="col">ไฟล์</th><th scope="col">ลูกค้า</th><th scope="col">เพศ</th><th scope="col">สัญชาติ</th><th scope="col">ทรีตเมนต์</th><th scope="col">ระยะเวลา</th><th scope="col">พนักงานนวด</th><th scope="col">ห้อง</th><th scope="col">สถานะ</th><th scope="col">ความมั่นใจ</th><th scope="col">จัดการ</th></tr></thead><tbody id="rows"></tbody></table></div><div id="empty" class="empty"><p class="sub">กำลังโหลดเอกสาร…</p></div></div>
<p id="scroll-hint" class="sr-only">ตารางกว้างกว่าหน้าจอ ใช้ปุ่มลูกศรซ้ายขวาเพื่อเลื่อนดูทุกคอลัมน์</p>
<nav class="pager" aria-label="เปลี่ยนหน้ารายการเอกสาร"><span id="range" class="sub num"></span><div class="acts"><button id="prev" class="btn sm" type="button">ก่อนหน้า</button><button id="next" class="btn sm" type="button">ถัดไป</button></div></nav>
</section>
</main>
<div id="notice" class="notice" aria-live="polite" hidden></div>
<dialog id="drawer" class="drawer" aria-labelledby="d-title"><div class="d-shell">
<header id="d-head" class="d-head"><div class="d-titles"><p class="eyebrow">ตรวจสอบเอกสาร</p><h2 id="d-title">กำลังโหลด…</h2><div id="d-status" class="d-status"></div></div><button id="d-close" class="btn sm" type="button" aria-label="ปิดหน้าตรวจสอบ">ปิด</button></header>
<div id="d-alert" class="d-alert" role="status" hidden></div>
<div id="d-body" class="d-body"><section class="d-preview" aria-label="เอกสารต้นฉบับ"><div class="p-tools"><span id="z-tools" class="acts"><button id="z-out" class="btn sm" type="button" aria-label="ย่อภาพ">−</button><span id="z-level" class="z-level" aria-live="polite">100%</span><button id="z-in" class="btn sm" type="button" aria-label="ขยายภาพ">+</button><button id="z-fit" class="btn sm ghost" type="button">พอดีกรอบ</button></span><span class="spacer"></span><button id="p-pdf" class="btn sm" type="button" hidden></button><a id="p-open" class="btn sm ghost" target="_blank" rel="noopener" hidden>เปิดในแท็บใหม่</a></div><div id="p-content" class="p-content"></div></section><section id="editor" class="d-editor" aria-label="ข้อมูลที่อ่านได้จากเอกสาร"></section></div>
<footer id="d-foot" class="d-foot"><span id="d-draft" class="draft" role="status"></span><div class="acts"><button id="d-next" class="btn" type="button" hidden>ตรวจเอกสารถัดไป</button><button id="d-cancel" class="btn" type="button">ปิด</button><button id="d-save" class="btn primary" type="button" disabled>บันทึกและยืนยัน</button></div></footer>
<div id="ask" class="ask" hidden><div class="ask-card" role="alertdialog" aria-modal="true" aria-labelledby="ask-title" aria-describedby="ask-text"><h3 id="ask-title"></h3><p id="ask-text"></p><div class="acts"><button id="ask-no" class="btn" type="button">กลับไปแก้ไขต่อ</button><button id="ask-yes" class="btn danger" type="button">ทิ้งการแก้ไข</button></div></div></div>
</div></dialog>
<dialog id="auth-dlg" class="modal auth" aria-labelledby="login-title"><div class="m-wrap"><div class="m-card auth-card">
<div class="brand"><span class="mark" aria-hidden="true"></span><strong>INNOVERA</strong></div>
<h1 id="login-title">เข้าสู่ระบบ</h1><p class="sub">ระบบอ่านเอกสาร OCR สำหรับพนักงาน</p>
<form id="login-form" method="post" action="/api/auth/login">
<label class="fld"><span class="fld-l">ชื่อผู้ใช้</span><input id="login-user" name="username" type="text" autocomplete="username" autocapitalize="none" spellcheck="false" maxlength="64" required></label>
<p id="login-hint" class="sub" hidden>ชื่อผู้ใช้เป็นภาษาอังกฤษ — ตรวจสอบแป้นพิมพ์</p>
<label class="fld"><span class="fld-l">รหัสผ่าน</span><span class="pw-wrap"><input id="login-pass" name="password" type="password" autocomplete="current-password" maxlength="128" required><button id="login-reveal" class="btn sm ghost" type="button" aria-pressed="false">แสดงรหัสผ่าน</button></span></label>
<p id="login-error" class="err" role="alert"></p>
<button id="login-submit" class="btn primary wide" type="submit">เข้าสู่ระบบ</button>
</form>
<p class="sub" id="login-help">ลืมรหัสผ่าน? ติดต่อผู้ดูแลระบบ</p>
</div></div></dialog>
<dialog id="pw-dlg" class="modal" aria-labelledby="pw-title"><div class="m-wrap"><div class="m-card">
<h2 id="pw-title">เปลี่ยนรหัสผ่าน</h2><p id="pw-note" class="sub"></p>
<form id="pw-form" method="post" action="/api/auth/password">
<label class="fld" id="pw-current-box"><span class="fld-l">รหัสผ่านปัจจุบัน</span><input id="pw-current" name="current" type="password" autocomplete="current-password" maxlength="128"></label>
<label class="fld"><span class="fld-l">รหัสผ่านใหม่</span><input id="pw-new" name="fresh" type="password" autocomplete="new-password" maxlength="128" required></label>
<label class="fld"><span class="fld-l">ยืนยันรหัสผ่านใหม่</span><input id="pw-confirm" name="again" type="password" autocomplete="new-password" maxlength="128" required></label>
<p class="sub" id="pw-policy">อย่างน้อย 12 ตัวอักษร ใช้ภาษาไทยหรือเว้นวรรคได้</p>
<p id="pw-error" class="err" role="alert"></p>
<div class="acts"><button id="pw-logout" class="btn ghost" type="button">ออกจากระบบ</button><button id="pw-cancel" class="btn" type="button">ยกเลิก</button><button id="pw-save" class="btn primary" type="submit">บันทึกรหัสผ่านใหม่</button></div>
</form>
</div></div></dialog>
<dialog id="users-dlg" class="modal" aria-labelledby="users-title"><div class="m-wrap"><div class="m-card wide">
<div class="m-head"><h2 id="users-title">ผู้ใช้งาน</h2><button id="users-close" class="btn sm" type="button">ปิด</button></div>
<p id="users-msg" class="sub" role="status"></p>
<div id="temp-box" class="temp" hidden><div><p class="sub">รหัสผ่านชั่วคราวของ <strong id="temp-for"></strong></p><code id="temp-pass" class="mono"></code><p class="sub">ส่งให้ผู้ใช้โดยตรง ใช้ได้ครั้งเดียวภายใน 72 ชั่วโมง</p></div><button id="temp-copy" class="btn sm" type="button">คัดลอก</button></div>
<div class="x-scroll"><table><caption class="sr-only">บัญชีผู้ใช้ทั้งหมดของร้าน</caption><thead><tr><th scope="col">ชื่อที่แสดง</th><th scope="col">ชื่อผู้ใช้</th><th scope="col">บทบาท</th><th scope="col">ส่งออกได้</th><th scope="col">สถานะ</th><th scope="col">เข้าใช้ล่าสุด</th><th scope="col">จัดการ</th></tr></thead><tbody id="users-rows"></tbody></table></div>
<form id="user-form" method="post" action="/api/users">
<h3 class="h-sm" id="nu-title">เพิ่มผู้ใช้ใหม่</h3><p class="sub">ระบบจะสร้างรหัสผ่านชั่วคราวให้ และผู้ใช้ต้องตั้งรหัสผ่านใหม่เมื่อเข้าสู่ระบบครั้งแรก</p>
<label class="fld"><span class="fld-l">ชื่อผู้ใช้ (ภาษาอังกฤษ)</span><input id="nu-name" type="text" autocomplete="off" autocapitalize="none" spellcheck="false" maxlength="64"></label>
<label class="fld"><span class="fld-l">ชื่อที่แสดง</span><input id="nu-display" type="text" autocomplete="off" maxlength="120"></label>
<label class="fld"><span class="fld-l">บทบาท</span><select id="nu-role"><option value="staff">พนักงาน</option><option value="admin">ผู้ดูแล</option></select></label>
<label class="chk"><input id="nu-export" type="checkbox"><span>อนุญาตให้ส่งออกข้อมูล</span></label>
<div class="acts"><button id="nu-add" class="btn primary" type="submit">เพิ่มผู้ใช้</button></div>
</form>
</div></div></dialog>
<dialog id="me-dlg" class="modal" aria-labelledby="me-title"><div class="m-wrap"><div class="m-card">
<div class="m-head"><h2 id="me-title">บัญชีของฉัน</h2><button id="me-close" class="btn sm" type="button">ปิด</button></div>
<p id="me-who" class="sub"></p>
<div class="acts"><button id="me-users" class="btn" type="button" hidden>ผู้ใช้งาน</button><button id="me-pw" class="btn" type="button">เปลี่ยนรหัสผ่าน</button><button id="me-logout" class="btn ghost" type="button">ออกจากระบบ</button></div>
</div></div></dialog>
<dialog id="confirm-dlg" class="modal" aria-labelledby="cf-title"><div class="m-wrap"><div class="m-card">
<h2 id="cf-title"></h2><p id="cf-text"></p>
<div class="acts"><button id="cf-no" class="btn" type="button">ยกเลิก</button><button id="cf-yes" class="btn danger" type="button">ยืนยัน</button></div>
</div></div></dialog>
<div id="checking" role="status">กำลังตรวจสอบการเข้าสู่ระบบ…</div>`;

const SCRIPT = String.raw`
(function(){'use strict';
const PAGE=50,CONCURRENCY=3,MAX_FILES=100,MAX_ITEMS=50,MAX_LEN=500,MAX_BYTES=209715200,MAX_NAME_CHARS=120,MAX_NAME_BYTES=1080;
/* Upload errors that fail the same way every time: no retry button for them. */
const FINAL_UPLOAD_ERRORS=['UNSUPPORTED_MEDIA_TYPE','PAYLOAD_TOO_LARGE','BATCH_FULL','IDEMPOTENCY_CONFLICT','INVALID_UPLOAD_HEADERS','FILENAME_TOO_LONG','FILENAME_TOO_LARGE','INVALID_BATCH_ID','BATCH_NOT_FOUND'];
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EXT={png:'image/png',jpg:'image/jpeg',jpeg:'image/jpeg',webp:'image/webp',pdf:'application/pdf'};
const ALLOWED=['image/png','image/jpeg','image/webp','application/pdf'];
const CATEGORY={queued:'รอคิว',processing:'กำลังอ่าน',review:'รอตรวจสอบ',succeeded:'อ่านสำเร็จ',confirmed:'ยืนยันแล้ว',failed:'ไม่สำเร็จ',split:'แยกเป็นรายหน้าแล้ว'};
/* Coded failures of the PDF split (worker) and of one page's render: shown in Thai, the code stays in the tooltip. */
const SPLIT_ERRORS={PDF_ENCRYPTED:'PDF ตั้งรหัสผ่านไว้ ระบบเปิดไม่ได้ กรุณาอัปโหลดไฟล์ที่ไม่มีรหัสผ่าน',PDF_TOO_MANY_PAGES:'PDF มีจำนวนหน้าเกินที่ระบบรองรับ กรุณาแบ่งไฟล์แล้วอัปโหลดใหม่',PDF_PAGE_TOO_LARGE:'หน้ากระดาษใน PDF ใหญ่เกินกำหนด',PDF_RENDER_FAILED:'อ่านไฟล์ PDF ไม่ได้ (ไฟล์อาจเสียหาย)',PDF_RENDERER_UNAVAILABLE:'ระบบแยก PDF ยังไม่พร้อม กรุณาลองอีกครั้งภายหลัง',PAGE_RENDER_FAILED:'แปลงหน้านี้เป็นภาพไม่สำเร็จ กด "ลองอีกครั้ง" เพื่อแปลงใหม่'};
const PDF_NOTE='ไฟล์ PDF จะถูกแยกเป็นหนึ่งแถวต่อหน้า ระบบอ่านได้ประมาณ 2–3 หน้าต่อนาที (95 หน้า ≈ 40 นาที) ปิดหน้านี้ได้ ระบบทำงานต่อเอง';
const DELIVERY={PENDING:'รอส่งการแก้ไขให้ AI',DELIVERED:'AI รับการแก้ไขแล้ว',RETRYING:'กำลังลองส่งการแก้ไขให้ AI อีกครั้ง',FAILED:'ส่งการแก้ไขให้ AI ไม่สำเร็จ'};
const SOURCE={ocr:'อ่านด้วย OCR',checkbox:'จากช่องทำเครื่องหมาย','ink-mark':'ตรวจจากรอยหมึก',rule:'ตามกฎของระบบ','master-fuzzy':'เทียบกับรายการบริการ','visual-alias':'เดาจากลายมือที่มักอ่านผิด (ต้องตรวจ)','verified-memory':'จากข้อมูลที่เคยยืนยัน',none:'ไม่พบข้อมูล',human:'แก้ไขโดยพนักงาน'};
const LABEL={formNumber:'เลขที่ฟอร์ม',date:'วันที่',time:'เวลา',branch:'สาขา',name:'ชื่อลูกค้า',gender:'เพศ',nationality:'สัญชาติ',hotelName:'โรงแรมที่พัก',referralSources:'รู้จักร้านจาก',healthConditions:'ภาวะสุขภาพ',pressure:'แรงกด',massageOilScrub:'น้ำมัน / สครับ',preferredAreas:'จุดที่ต้องการเน้น',avoidAreas:'จุดที่ควรหลีกเลี่ยง',treatments:'ทรีตเมนต์',therapistName:'พนักงานนวด',roomNo:'ห้อง',duration:'ระยะเวลา'};
/* optional section, or a third field entry true: a v3.1 addition, not shown when an older result does not have it. */
const SECTIONS=[{key:'header',title:'หัวแบบฟอร์ม',optional:true,fields:[['formNumber','field'],['date','field'],['time','field']]},{key:'customerInformation',title:'ข้อมูลลูกค้า',fields:[['name','field'],['gender','field'],['nationality','field'],['hotelName','field'],['referralSources','list'],['healthConditions','list']]},{key:'recommendationCard',title:'คำแนะนำการนวด',fields:[['pressure','field'],['massageOilScrub','list'],['preferredAreas','list'],['avoidAreas','list']]},{key:'staffOnly',title:'สำหรับพนักงาน',fields:[['treatments','treatments'],['therapistName','field'],['roomNo','field'],['branch','field',true]]}];
/* Documents confirmed before login existed carry an actor that matches no user row: the shared front-desk account. */
const LEGACY_REVIEWER='บัญชีรวม (ก่อนมีระบบล็อกอิน)';
const ROLE={admin:'ผู้ดูแล',staff:'พนักงาน'};
const USER_STATUS={active:'ใช้งานอยู่',disabled:'ปิดใช้งาน',locked:'ถูกล็อกชั่วคราว',must_change:'ต้องตั้งรหัสผ่านใหม่'};
/* Every top-layer dialog. The drop zone and the "/" shortcut are ignored while any of them is open. */
const MODALS=['auth-dlg','pw-dlg','users-dlg','me-dlg','confirm-dlg'];
const ERRORS={NETWORK:'เชื่อมต่อเซิร์ฟเวอร์ไม่ได้ กรุณาตรวจสอบอินเทอร์เน็ตแล้วลองใหม่',TIMEOUT:'อัปโหลดใช้เวลานานเกินไป กรุณาลองใหม่',REVIEW_CONFLICT:'มีผู้อื่นบันทึกเอกสารนี้หลังจากที่คุณเปิด',DOCUMENT_NOT_REVIEWABLE:'เอกสารนี้ยังไม่อยู่ในสถานะที่ตรวจสอบได้',DOCUMENT_NOT_RETRYABLE:'เอกสารนี้ส่งอ่านใหม่ไม่ได้ (ไฟล์ยังไม่ผ่านการตรวจความปลอดภัย หรือไม่ได้อยู่ในสถานะไม่สำเร็จ) กรุณาอัปโหลดไฟล์ใหม่',DOCUMENT_QUARANTINED:'ไฟล์นี้ไม่ผ่านการตรวจความปลอดภัย จึงไม่แสดงต้นฉบับ กรุณาอัปโหลดไฟล์ใหม่',DOCUMENT_NOT_SCANNED:'ไฟล์นี้ยังตรวจความปลอดภัยไม่เสร็จ จึงยังแสดงต้นฉบับไม่ได้',UPLOAD_IN_PROGRESS:'ไฟล์นี้ยังอยู่ระหว่างตรวจจากการส่งครั้งก่อน กรุณาลองใหม่ในอีก 2–3 นาที',INVALID_UPLOAD_HEADERS:'ข้อมูลไฟล์ไม่ถูกต้อง (ไฟล์ว่าง ใหญ่เกิน 200 MB หรือชื่อไฟล์ผิดรูปแบบ)',FILENAME_TOO_LONG:'ชื่อไฟล์ยาวเกิน 120 ตัวอักษร กรุณาเปลี่ยนชื่อไฟล์',FILENAME_TOO_LARGE:'ชื่อไฟล์ยาวเกินกำหนด กรุณาเปลี่ยนชื่อไฟล์',INVALID_BATCH_ID:'รหัสชุดอัปโหลดไม่ถูกต้อง',DOCUMENT_NOT_FOUND:'ไม่พบเอกสารนี้',CONTENT_NOT_FOUND:'ไม่พบไฟล์ต้นฉบับของเอกสารนี้',BATCH_NOT_FOUND:'ไม่พบชุดอัปโหลดนี้',BATCH_FULL:'ชุดอัปโหลดนี้ครบจำนวนไฟล์แล้ว',IDEMPOTENCY_CONFLICT:'ไฟล์นี้ถูกส่งซ้ำด้วยข้อมูลต่างกัน กรุณาเลือกไฟล์ใหม่อีกครั้ง',PAYLOAD_TOO_LARGE:'ไฟล์มีขนาดใหญ่เกินกำหนด',UNSUPPORTED_MEDIA_TYPE:'ไม่รองรับไฟล์ประเภทนี้ (ใช้ได้เฉพาะ PNG, JPG, WebP และ PDF)',REVIEW_INVALID:'ข้อมูลที่แก้ไขไม่ถูกต้อง (ข้อความยาวเกิน 500 ตัวอักษร หรือรายการเกิน 50 รายการ)',
USER_CHANGED:'มีการเข้าสู่ระบบด้วยบัญชีอื่น กำลังโหลดหน้านี้ใหม่',INVALID_CREDENTIALS:'ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง',PASSWORD_EXPIRED:'รหัสผ่านชั่วคราวหมดอายุหรือถูกใช้ไปแล้ว กรุณาขอรหัสผ่านใหม่จากผู้ดูแลระบบ',LOGIN_THROTTLED:'พยายามเข้าสู่ระบบบ่อยเกินไป กรุณารอสักครู่แล้วลองใหม่',LOGIN_BUSY:'ระบบกำลังตรวจสอบรหัสผ่านจำนวนมาก กรุณาลองใหม่ในอีกสักครู่',LOGIN_NOT_CONFIGURED:'ระบบเข้าสู่ระบบยังไม่พร้อมใช้งาน กรุณาติดต่อผู้ดูแลระบบ',INVALID_LOGIN:'ข้อมูลเข้าสู่ระบบไม่ถูกต้อง',UNAUTHENTICATED:'กรุณาเข้าสู่ระบบอีกครั้ง',CSRF_REJECTED:'คำขอถูกปฏิเสธเพื่อความปลอดภัย กรุณาลองใหม่อีกครั้ง',FORBIDDEN:'บัญชีของคุณไม่มีสิทธิ์ใช้งานส่วนนี้',PASSWORD_CHANGE_REQUIRED:'กรุณาตั้งรหัสผ่านใหม่ก่อนใช้งานต่อ',PASSWORD_INCORRECT:'รหัสผ่านปัจจุบันไม่ถูกต้อง',PASSWORD_UNCHANGED:'รหัสผ่านใหม่ต้องไม่ซ้ำกับรหัสผ่านเดิม',WEAK_PASSWORD:'รหัสผ่านไม่ปลอดภัยพอ: ใช้อย่างน้อย 12 ตัวอักษร ไม่ซ้ำกับชื่อผู้ใช้ และไม่ใช่รหัสผ่านที่ใช้กันทั่วไป',USERNAME_TAKEN:'มีชื่อผู้ใช้นี้อยู่แล้ว',INVALID_USERNAME:'ชื่อผู้ใช้ไม่ถูกต้อง (ใช้ได้เฉพาะภาษาอังกฤษ ตัวเลข จุด ขีดกลางและขีดล่าง)',INVALID_DISPLAY_NAME:'ชื่อที่แสดงไม่ถูกต้อง',INVALID_ROLE:'บทบาทไม่ถูกต้อง',USER_INVALID:'ข้อมูลผู้ใช้ไม่ถูกต้อง',USER_NOT_FOUND:'ไม่พบผู้ใช้นี้',LAST_ADMIN:'ต้องเหลือผู้ดูแลระบบที่ใช้งานได้อย่างน้อยหนึ่งคน',CANNOT_CHANGE_SELF:'เปลี่ยนสิทธิ์หรือรีเซ็ตรหัสผ่านของบัญชีตัวเองที่นี่ไม่ได้'};
const state={user:null,csrf:'',authWait:null,authSettle:null,authBefore:null,csrfWait:null,rearm:null,leaving:false,started:false,bg:0,xhrs:new Set(),users:[],tempPass:'',pwForced:false,pwBusy:false,pwResolve:null,loginBusy:false,confirmResolve:null,confirmReturn:null,conn:'',docs:[],total:0,offset:0,q:'',status:'',batchFilter:'',parentFilter:'',parentName:'',pdfView:false,batches:[],batchId:null,batch:null,listSeq:0,listAbort:null,listSig:'',loaded:false,uploads:[],active:0,timer:0,ticking:false,soon:0,searchTimer:0,noticeTimer:0,current:null,draft:null,originalSig:'',editable:false,dirty:false,saving:false,blobUrl:'',previewSeq:0,previewAbort:null,previewMissing:false,zoom:1,openSeq:0,lastFocus:null,askResolve:null,askReturn:null,uid:0,inputs:new WeakMap()};
const $=id=>document.getElementById(id);
const dateFmt=new Intl.DateTimeFormat('th-TH',{day:'numeric',month:'short',hour:'2-digit',minute:'2-digit'});
const timeFmt=new Intl.DateTimeFormat('th-TH',{hour:'2-digit',minute:'2-digit',second:'2-digit'});

function has(o,k){return o!==null&&typeof o==='object'&&Object.prototype.hasOwnProperty.call(o,k);}
function isObj(v){return v!==null&&typeof v==='object'&&!Array.isArray(v);}
function str(v){return v===null||v===undefined?'':String(v);}
function el(tag,cls,text){const e=document.createElement(tag);if(cls)e.className=cls;if(text!==undefined&&text!==null)e.textContent=String(text);return e;}
function btn(text,cls,onClick,label){const b=el('button','btn'+(cls?' '+cls:''),text);b.type='button';if(label)b.setAttribute('aria-label',label);if(onClick)b.addEventListener('click',onClick);return b;}
function cell(value,cls){const s=str(value).trim();const td=el('td',cls);if(s)td.textContent=s;else td.append(el('span','none','—'));return td;}
function pct(c){if(typeof c!=='number'||!isFinite(c))return '—';return Math.round(c<=1?c*100:c)+'%';}
function when(iso){if(!iso)return '';const d=new Date(iso);return isNaN(d.getTime())?'':dateFmt.format(d);}
function clock(ms){if(typeof ms!=='number'||!isFinite(ms)||ms<0)return '—';const s=Math.round(ms/1000),h=Math.floor(s/3600),m=Math.floor(s%3600/60),r=s%60,two=n=>String(n).padStart(2,'0');return h?h+':'+two(m)+':'+two(r):m+':'+two(r);}
function size(b){if(typeof b!=='number')return '';return b<1048576?Math.max(1,Math.round(b/1024))+' KB':(b/1048576).toFixed(1)+' MB';}
function reduced(){return window.matchMedia('(prefers-reduced-motion: reduce)').matches;}
function apiError(status,code){const msg=has(ERRORS,code)?ERRORS[code]:status===401?'กรุณาเข้าสู่ระบบอีกครั้ง':status>=500?'ระบบขัดข้องชั่วคราว ('+status+') กรุณาลองใหม่':'คำขอไม่สำเร็จ ('+status+(code?' · '+code:'')+')';const e=new Error(msg);e.status=status;e.code=code||'';return e;}

function setConnection(kind,detail){const c=$('conn');c.title=detail||'';if(state.conn===kind)return;state.conn=kind;c.className='conn c-'+kind;$('conn-text').textContent=kind==='ok'?'เชื่อมต่อแล้ว':kind==='error'?'เชื่อมต่อไม่ได้ · กำลังลองใหม่':'กำลังเชื่อมต่อ…';}
/* Marks the fetches started inside fn as background polling: they authenticate but do not move the idle deadline. */
function background(fn){state.bg++;try{return fn();}finally{state.bg--;}}
/* The session is a cookie the script cannot read; the only credential it holds is the CSRF token of that session. */
async function api(path,opts,retried){const o=Object.assign({cache:'no-store',credentials:'same-origin'},opts||{});const method=String(o.method||'GET').toUpperCase();
o.headers=Object.assign({},(opts&&opts.headers)||{});if(method!=='GET'&&method!=='HEAD')o.headers['X-CSRF-Token']=state.csrf;if(state.bg>0)o.headers['X-OCR-Background']='1';
let r;try{r=await fetch(path,o);}catch(e){if(e&&e.name==='AbortError')throw e;setConnection('error');throw apiError(0,'NETWORK');}
if(r.ok){setConnection('ok');return r;}
let code='';try{const d=await r.json();if(d&&typeof d.error==='string')code=d.error;}catch(e){}
/* A different user logging in rejects the wait with USER_CHANGED, which is final: nothing is retried or resent. */
if(!retried&&r.status===401){await requireLogin();return api(path,opts,true);}
if(!retried&&r.status===403&&code==='CSRF_REJECTED'){await refreshSession();return api(path,opts,true);}
if(r.status===403&&code==='PASSWORD_CHANGE_REQUIRED')openPassword(true);
if(r.status===401)setConnection('error');
throw apiError(r.status,code);}
async function getJson(path,opts){const r=await api(path,opts);return r.json();}
function postJson(path,body){return getJson(path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body||{})});}

/* ---------- session, login and the user menu ---------- */
/* The auth routes answer 401 by design (an expired session, a wrong password), so they never go through api(): a 401
   here must report itself, not reopen the login dialog on top of the dialog that asked. */
async function authCall(path,body){const init=body===undefined?{cache:'no-store',credentials:'same-origin'}
:{method:'POST',cache:'no-store',credentials:'same-origin',headers:{'Content-Type':'application/json','X-CSRF-Token':state.csrf},body:JSON.stringify(body)};
let r;try{r=await fetch(path,init);}catch(e){throw apiError(0,'NETWORK');}
let d={};try{d=await r.json();}catch(e){}
if(!r.ok)throw apiError(r.status,d&&typeof d.error==='string'?d.error:'');
return isObj(d)?d:{};}
function adoptSession(data){if(!isObj(data)||!isObj(data.user))return null;state.user=data.user;state.csrf=typeof data.csrfToken==='string'?data.csrfToken:'';return state.user;}
async function checkSession(){try{return adoptSession(await authCall('/api/auth/session'));}catch(e){if(e.status===401)return null;throw e;}}
/* A stale CSRF token (another tab logged in, or the password rotated) fails every save, upload and retry with 403
   while GETs keep working, so it is refreshed once from the session route instead of losing the draft to a reload. */
function refreshSession(){if(state.csrfWait)return state.csrfWait;
const before=state.user?state.user.id:null;
state.csrfWait=(async()=>{let data;try{data=await authCall('/api/auth/session');}catch(e){if(e.status===401)return requireLogin();throw e;}
if(!isObj(data.user))return requireLogin();
if(before&&data.user.id!==before)throw userChanged();
adoptSession(data);applyUser();return state.user;})();
const wait=state.csrfWait;wait.catch(()=>undefined).then(()=>{if(state.csrfWait===wait)state.csrfWait=null;});
return wait;}
/* Opens the login dialog over the page and clears every rendered piece of customer data first: an opaque backdrop
   alone would leave names, the open health form and the draft in the DOM of a shared front-desk PC. */
function requireLogin(){if(state.authWait)return state.authWait;
state.authBefore=state.user?state.user.id:null;
state.user=null;state.csrf='';
document.body.dataset.auth='out';
clearPhi();
setLoginError('');$('login-pass').value='';setLoginBusy(false);
const d=$('auth-dlg');if(!d.open)d.showModal();
state.authWait=new Promise((resolve,reject)=>{state.authSettle={resolve,reject};});
$('login-user').focus();
return state.authWait;}
/* A different account logged in. Everything in flight is stopped and the beforeunload guard is turned off BEFORE the
   reload, because navigation is asynchronous: a resolved waiter would otherwise send user A's save and start A's
   queued uploads carrying B's cookie and CSRF token, and the guard would offer B "Stay" inside A's draft. */
function userChanged(){state.leaving=true;state.dirty=false;
clearTimeout(state.timer);state.timer=0;clearTimeout(state.soon);clearTimeout(state.searchTimer);clearTimeout(state.noticeTimer);
abortInFlight();
state.uploads.forEach(u=>{if(u.status==='waiting'||u.status==='authwait'){u.status='cancelled';u.error='ยกเลิก (เปลี่ยนผู้ใช้)';paintUpload(u);}});
const err=apiError(0,'USER_CHANGED');
const settle=state.authSettle;state.authSettle=null;state.authWait=null;state.rearm=null;
if(settle)settle.reject(err);
location.replace(location.pathname+location.search);
return err;}
function abortInFlight(){state.xhrs.forEach(x=>{try{x.abort();}catch(e){}});state.xhrs.clear();
if(state.listAbort){state.listAbort.abort();state.listAbort=null;}if(state.previewAbort){state.previewAbort.abort();state.previewAbort=null;}}
function setLoginBusy(on){state.loginBusy=!!on;$('login-submit').disabled=!!on;$('login-submit').textContent=on?'กำลังเข้าสู่ระบบ…':'เข้าสู่ระบบ';}
function setLoginError(text){$('login-error').textContent=text||'';}
async function submitLogin(){if(state.loginBusy)return;
const username=String($('login-user').value||'').trim(),password=String($('login-pass').value||'');
$('login-pass').value='';
if(!username||!password){setLoginError('กรุณากรอกชื่อผู้ใช้และรหัสผ่าน');return;}
setLoginBusy(true);setLoginError('');
let data;try{data=await authCall('/api/auth/login',{username,password});}
catch(e){setLoginBusy(false);setLoginError(e.message);$('login-pass').focus();return;}
setLoginBusy(false);loginDone(data);}
function loginDone(data){const user=adoptSession(data);if(!user){setLoginError(ERRORS.NETWORK);return;}
if(state.authBefore&&user.id!==state.authBefore){userChanged();return;}
state.authBefore=null;
const d=$('auth-dlg');if(d.open)d.close();
document.body.dataset.auth='in';applyUser();setConnection('ok');
const settle=state.authSettle;state.authSettle=null;state.authWait=null;state.rearm=null;
if(settle)settle.resolve(user);
if(user.mustChangePassword){openPassword(true);return;}
restoreAfterLogin();}
/* The same user came back: the rows, the batch strip and the drawer are rebuilt from a fresh load, and the draft that
   survived the clear is re-rendered exactly as it was (loadReview keeps its hands off a dirty or saving drawer). */
function restoreAfterLogin(){if(!state.started||state.leaving)return;
state.listSig='';
if(!state.listAbort)loadDocuments();
loadBatches();if(state.batchId)loadBatch();
/* clearPhi() blanked the drawer head, and loadReview() keeps its hands off a dirty drawer — which is exactly the case
   this release exists for — so the head is restored from state here instead of waiting for a load that will not come. */
if($('drawer').open&&state.current&&state.current.documentId){const seq=state.openSeq;state.pdfView=false;
$('d-title').textContent=titleOf(state.current);pageLink();setDirty(state.dirty);renderHead();renderEditor();loadPreview(seq,state.current.documentId);loadReview(seq);}}
function narrow(){return window.matchMedia('(max-width: 720px)').matches;}
/* Below 720px a name, a badge and three pills would push the 56px header past 375px, so they collapse into one pill. */
function showMenu(on){const small=narrow();$('me').hidden=!on||small;$('me-open').hidden=!on||!small;}
function applyUser(){const u=state.user;if(!u)return;
const name=str(u.displayName)||str(u.username),admin=u.role==='admin',role=ROLE[u.role]||ROLE.staff;
document.body.dataset.auth='in';document.body.dataset.role=admin?'admin':'staff';
$('me-name').textContent=name;$('me-role').textContent=role;$('me-open-name').textContent=name;$('me-who').textContent=name+' · '+role;
$('users-open').hidden=!admin;$('me-users').hidden=!admin;
showMenu(true);}
/* Everything rendered from customer data. Only state.draft and the id of the open document survive, so an interrupted
   review resumes after the same user logs back in. */
function clearPhi(){state.docs=[];state.total=0;state.loaded=false;state.listSig='';state.batches=[];state.batch=null;state.users=[];
$('rows').replaceChildren();$('range').textContent='';$('updated').textContent='';
const empty=$('empty');empty.replaceChildren(el('p','sub','กรุณาเข้าสู่ระบบเพื่อดูรายการเอกสาร'));empty.hidden=false;
$('parent-chip').hidden=true;$('parent-chip-text').replaceChildren();
$('batch').hidden=true;$('batch-title').textContent='ชุดอัปโหลดล่าสุด';$('batch-meta').textContent='';$('batch-bar').replaceChildren();$('batch-stats').replaceChildren();
renderBatchOptions();
$('d-title').textContent='กำลังโหลด…';$('d-status').replaceChildren();$('editor').replaceChildren();$('d-draft').textContent='';hideAlert();
clearPreview();
$('users-rows').replaceChildren();$('users-msg').textContent='';clearTemp();
$('notice').hidden=true;showMenu(false);}
async function logout(){const busy=state.active>0||state.uploads.some(u=>u.status==='waiting'||u.status==='authwait');
if(busy&&!(await confirmAsk('ออกจากระบบ?','ยังมีไฟล์ที่กำลังอัปโหลดหรือรออัปโหลด ไฟล์เหล่านี้จะถูกยกเลิก','ออกจากระบบ')))return;
state.leaving=true;state.dirty=false;
clearTimeout(state.timer);state.timer=0;clearTimeout(state.soon);clearTimeout(state.searchTimer);clearTimeout(state.noticeTimer);
abortInFlight();
try{await fetch('/api/auth/logout',{method:'POST',cache:'no-store',credentials:'same-origin',headers:{'X-CSRF-Token':state.csrf}});}catch(e){}
location.replace('/');}

/* ---------- password ---------- */
function setPwError(text){$('pw-error').textContent=text||'';}
/* A forced change cannot be dismissed, but it always offers ออกจากระบบ: the server allows logout in this state, and
   without it someone who logged in with the wrong account has no way out but closing the tab. */
function openPassword(forced){state.pwForced=!!forced;
$('pw-note').textContent=forced?'ระบบกำหนดให้ตั้งรหัสผ่านใหม่ก่อนเริ่มใช้งาน':'ตั้งรหัสผ่านใหม่สำหรับบัญชีของคุณ';
$('pw-current-box').hidden=!!forced;$('pw-cancel').hidden=!!forced;
$('pw-current').value='';$('pw-new').value='';$('pw-confirm').value='';setPwError('');$('pw-save').disabled=false;state.pwBusy=false;
const d=$('pw-dlg');if(!d.open)d.showModal();
$(forced?'pw-new':'pw-current').focus();}
function forcedPasswordChange(){return new Promise(resolve=>{state.pwResolve=resolve;openPassword(true);});}
function closePassword(){if(state.pwForced)return;const d=$('pw-dlg');if(d.open)d.close();
$('pw-current').value='';$('pw-new').value='';$('pw-confirm').value='';setPwError('');}
async function submitPassword(){if(state.pwBusy)return;
const fresh=String($('pw-new').value||''),again=String($('pw-confirm').value||'');
if(!fresh){setPwError('กรุณากรอกรหัสผ่านใหม่');$('pw-new').focus();return;}
if(fresh!==again){setPwError('รหัสผ่านใหม่ทั้งสองช่องไม่ตรงกัน');$('pw-confirm').focus();return;}
const body={newPassword:fresh};if(!$('pw-current-box').hidden)body.currentPassword=String($('pw-current').value||'');
state.pwBusy=true;$('pw-save').disabled=true;setPwError('');
let data;try{data=await authCall('/api/auth/password',body);}
catch(e){state.pwBusy=false;$('pw-save').disabled=false;
/* Past the 5-minute window a forced change needs the temporary password after all: ask for it instead of dead-ending. */
if(e.code==='PASSWORD_INCORRECT'&&$('pw-current-box').hidden){$('pw-current-box').hidden=false;setPwError('หน้านี้เปิดค้างไว้นานเกินไป กรุณากรอกรหัสผ่านปัจจุบันอีกครั้ง');$('pw-current').focus();return;}
setPwError(e.message);return;}
state.pwBusy=false;$('pw-save').disabled=false;
const was=state.pwForced;state.pwForced=false;
adoptSession(data);applyUser();
$('pw-current').value='';$('pw-new').value='';$('pw-confirm').value='';setPwError('');
const d=$('pw-dlg');if(d.open)d.close();
notify('เปลี่ยนรหัสผ่านเรียบร้อยแล้ว');
const resolve=state.pwResolve;state.pwResolve=null;
if(resolve)resolve();else if(was)restoreAfterLogin();}

/* ---------- user administration (admin only; every refusal is still the server's) ---------- */
function clearTemp(){state.tempPass='';$('temp-box').hidden=true;$('temp-pass').textContent='';$('temp-for').textContent='';}
function showTemp(name,password){if(typeof password!=='string'||!password)return;state.tempPass=password;$('temp-for').textContent=name;$('temp-pass').textContent=password;$('temp-box').hidden=false;}
function openUsers(){closeMe();const d=$('users-dlg');if(!d.open)d.showModal();clearTemp();$('users-rows').replaceChildren();$('users-msg').textContent='กำลังโหลดรายชื่อผู้ใช้…';loadUsers();}
function closeUsers(){const d=$('users-dlg');if(d.open)d.close();}
async function loadUsers(){try{const data=await getJson('/api/users');state.users=(Array.isArray(data.users)?data.users:[]).filter(isObj);$('users-msg').textContent='';renderUsers();}
catch(e){$('users-msg').textContent=e.message;}}
function renderUsers(){$('users-rows').replaceChildren(...state.users.map(userRow));}
function userRow(u){const tr=el('tr'),me=!!(state.user&&state.user.id===u.id),admin=u.role==='admin',off=u.status==='disabled',exp=u.canExport===true;
tr.append(cell(u.displayName),cell(u.username,'mono'),cell(ROLE[u.role]||u.role),cell(exp?'ใช่':'ไม่'));
const st=el('td'),badgeEl=el('span','badge u-'+str(u.status));badgeEl.append(el('span','dot'),document.createTextNode(USER_STATUS[u.status]||str(u.status)));st.append(badgeEl);
tr.append(st,cell(u.lastLoginAt?when(u.lastLoginAt):'ยังไม่เคยเข้าใช้'));
const act=el('td'),box=el('div','acts'),who=str(u.displayName)||str(u.username);
/* A self reset or unlock revokes your own session, so the login dialog would cover the one-time password you now need. */
if(!me)box.append(btn('รีเซ็ตรหัสผ่าน','sm',()=>resetUser(u,who)),btn('ปลดล็อก','sm',()=>unlockUser(u,who)));
box.append(btn(off?'เปิดใช้งาน':'ปิดใช้งาน','sm'+(off?'':' danger'),()=>changeUser(u,{disabled:!off},off?'เปิดใช้งานบัญชีนี้?':'ปิดใช้งานบัญชีนี้?',(off?'ผู้ใช้จะเข้าสู่ระบบได้อีกครั้ง · ':'ผู้ใช้จะออกจากระบบทันทีและเข้าใช้ไม่ได้อีก · ')+who)));
box.append(btn(admin?'เปลี่ยนเป็นพนักงาน':'เปลี่ยนเป็นผู้ดูแล','sm',()=>changeUser(u,{role:admin?'staff':'admin'},'เปลี่ยนบทบาท?',(admin?'บัญชีนี้จะจัดการผู้ใช้ไม่ได้อีก · ':'บัญชีนี้จะจัดการผู้ใช้ทั้งหมดได้ · ')+who)));
box.append(btn(exp?'ยกเลิกสิทธิ์ส่งออก':'อนุญาตส่งออก','sm',()=>changeUser(u,{canExport:!exp},'เปลี่ยนสิทธิ์ส่งออก?',(exp?'บัญชีนี้จะดาวน์โหลดไฟล์ส่งออกไม่ได้ · ':'บัญชีนี้จะดาวน์โหลดไฟล์ส่งออกได้ · ')+who)));
act.append(box);tr.append(act);return tr;}
async function userAction(run){$('users-msg').textContent='';try{await run();await loadUsers();}catch(e){$('users-msg').textContent=e.message;}}
async function changeUser(u,changes,title,text){if(!(await confirmAsk(title,text,'ยืนยัน')))return;
return userAction(()=>postJson('/api/users/'+encodeURIComponent(u.id),changes));}
async function resetUser(u,who){if(!(await confirmAsk('รีเซ็ตรหัสผ่าน?','ระบบจะสร้างรหัสผ่านชั่วคราวใหม่ให้ '+who+' และบัญชีนี้จะออกจากระบบทันที','รีเซ็ตรหัสผ่าน')))return;
return userAction(async()=>{const r=await postJson('/api/users/'+encodeURIComponent(u.id)+'/reset-password',{});showTemp(who,r&&r.temporaryPassword);});}
async function unlockUser(u,who){if(!(await confirmAsk('ปลดล็อกบัญชี?','บัญชี '+who+' จะเข้าสู่ระบบได้ทันที','ปลดล็อก')))return;
return userAction(()=>api('/api/users/'+encodeURIComponent(u.id)+'/unlock',{method:'POST'}));}
async function addUser(){const username=String($('nu-name').value||'').trim(),displayName=String($('nu-display').value||'').trim();
if(!username||!displayName){$('users-msg').textContent='กรุณากรอกชื่อผู้ใช้และชื่อที่แสดง';return;}
const role=$('nu-role').value==='admin'?'admin':'staff',canExport=$('nu-export').checked===true;
return userAction(async()=>{const r=await postJson('/api/users',{username,displayName,role,canExport});showTemp(displayName,r&&r.temporaryPassword);
$('nu-name').value='';$('nu-display').value='';$('nu-export').checked=false;$('nu-role').value='staff';});}
function copyTemp(){if(!state.tempPass)return;try{if(typeof navigator!=='undefined'&&navigator.clipboard)navigator.clipboard.writeText(state.tempPass).then(()=>notify('คัดลอกรหัสผ่านชั่วคราวแล้ว'),()=>notify('คัดลอกไม่สำเร็จ กรุณาเลือกข้อความแล้วคัดลอกเอง','error'));}catch(e){}}

/* ---------- a real top-level confirmation ---------- */
/* The drawer's "ask" overlay lives inside <dialog id="drawer"> and is only un-hidden there: called from the header or
   from users-dlg it would focus an invisible button and hang on a promise that nothing can resolve. */
function confirmAsk(title,text,yes){if(state.confirmResolve)answerConfirm(false);
state.confirmReturn=document.activeElement;
$('cf-title').textContent=title;$('cf-text').textContent=text;$('cf-yes').textContent=yes||'ยืนยัน';
const d=$('confirm-dlg');if(!d.open)d.showModal();$('cf-no').focus();
return new Promise(resolve=>{state.confirmResolve=resolve;});}
function answerConfirm(v){const r=state.confirmResolve;if(!r)return;state.confirmResolve=null;
const d=$('confirm-dlg');if(d.open)d.close();
const back=state.confirmReturn;state.confirmReturn=null;if(!v&&back&&document.contains(back))back.focus();r(v);}
function closeMe(){const d=$('me-dlg');if(d.open)d.close();}
function modalOpen(){return MODALS.some(id=>$(id).open);}

function notify(text,kind){const n=$('notice');clearTimeout(state.noticeTimer);n.className='notice'+(kind==='error'?' is-error':'');n.replaceChildren(el('span','dot'),el('span','notice-text',text),btn('ปิด','sm ghost',()=>{n.hidden=true;},'ปิดข้อความ'));n.hidden=false;if(kind!=='error')state.noticeTimer=setTimeout(()=>{n.hidden=true;},6000);}

function categoryOf(d){if(!d)return 'queued';if(typeof d.statusCategory==='string'&&has(CATEGORY,d.statusCategory))return d.statusCategory;const s=String(d.status||'').toUpperCase();if(s==='SPLIT')return 'split';if(s==='NEEDS_REVIEW')return 'review';if(s==='SUCCEEDED')return d.reviewedAt?'confirmed':'succeeded';if(s==='FAILED'||s==='QUARANTINED')return 'failed';if(s==='PROCESSING')return 'processing';return 'queued';}
function badge(cat){const b=el('span','badge b-'+cat);b.append(el('span','dot'),document.createTextNode(CATEGORY[cat]||CATEGORY.queued));return b;}
function deliveryBadge(status){const b=el('span','badge d-'+String(status).toLowerCase());b.append(el('span','dot'),document.createTextNode(DELIVERY[status]));return b;}
function splitError(m){const c=/^([A-Z_]+)(?::\s*(.*))?$/.exec(m);if(!c||!has(SPLIT_ERRORS,c[1]))return '';const n=c[1]==='PDF_TOO_MANY_PAGES'?/^(\d+) pages \(limit (\d+)\)$/.exec(c[2]||''):null;return n?'PDF มี '+n[1]+' หน้า เกินที่ระบบรองรับ (สูงสุด '+n[2]+' หน้า) กรุณาแบ่งไฟล์แล้วอัปโหลดใหม่':SPLIT_ERRORS[c[1]];}
function failText(d){if(String(d.status||'').toUpperCase()==='QUARANTINED')return 'ไฟล์ไม่ผ่านการตรวจความปลอดภัย';const m=typeof d.errorMessage==='string'?d.errorMessage.trim():'';const coded=m?splitError(m):'';if(coded)return coded;return m?'สาเหตุ: '+(m.length>90?m.slice(0,90)+'…':m):'อ่านเอกสารไม่สำเร็จ';}
/* A top-level PDF: split into one row per page by the worker (its own row only while it is being split, or when that failed). */
function isPdfFile(d){return !!d&&String(d.mimeType||'').toLowerCase()==='application/pdf'&&!d.parentDocumentId;}
function pageLabel(d){return d&&typeof d.pageNumber==='number'&&d.pageNumber>0?'หน้า '+d.pageNumber+(typeof d.pageCount==='number'?'/'+d.pageCount:''):'';}
function titleOf(d){const name=(d&&(d.parentFilename||d.filename))||(d&&d.documentId)||'';const p=pageLabel(d);return p?name+' · '+p:name;}
function statusNote(d,cat,s){if(cat==='review'){const n=typeof s.reviewFieldCount==='number'?s.reviewFieldCount:0;return n>0?'ต้องตรวจ '+n+' ช่อง':'ต้องตรวจสอบ';}if(cat==='failed')return failText(d);if(cat==='queued'&&typeof d.errorMessage==='string'&&/^RETRYING/.test(d.errorMessage))return isPdfFile(d)?'จะลองแยก PDF ใหม่อัตโนมัติ':'จะลองอ่านใหม่อัตโนมัติ';if(isPdfFile(d)&&cat==='processing')return 'กำลังแยก PDF เป็นรายหน้า'+(typeof d.pageCount==='number'?' ('+d.pageCount+' หน้า)':'');if(isPdfFile(d)&&cat==='queued')return 'รอแยก PDF เป็นรายหน้า';if(cat==='succeeded')return 'ยังไม่ได้ยืนยัน';if(cat==='confirmed')return has(DELIVERY,d.deliveryStatus)?DELIVERY[d.deliveryStatus]:(d.reviewedAt?'เมื่อ '+when(d.reviewedAt):'');return '';}

/* ---------- document table ---------- */
function lines(td,values){if(!values.length){td.append(el('span','none','—'));return;}const box=el('div','lines');values.forEach(v=>{const s=str(v).trim();box.append(s?el('span','line',s):el('span','line none','—'));});td.append(box);}
function actionButton(text,cls,action,d){const b=btn(text,cls,null,text+' '+(d.filename||''));b.dataset.action=action;b.dataset.doc=d.documentId;b.dataset.key=action+':'+d.documentId;return b;}
function row(d){const cat=categoryOf(d),s=isObj(d.summary)?d.summary:{},ts=Array.isArray(s.treatments)?s.treatments.filter(isObj):[];const tr=el('tr','r-'+cat);
/* A quarantined original is never opened or previewed; only FAILED documents can be sent back to the queue. */const upper=String(d.status||'').toUpperCase(),quarantined=upper==='QUARANTINED';
const file=el('td','c-file');let name;if(cat!=='queued'&&cat!=='processing'&&!quarantined){name=el('button','fname link',d.filename||d.documentId);name.type='button';name.dataset.action='review';name.dataset.doc=d.documentId;name.dataset.key='open:'+d.documentId;name.setAttribute('aria-label','เปิดเอกสาร '+(d.filename||d.documentId));}else name=el('div','fname',d.filename||d.documentId);name.title=str(d.filename);const mb=badge(cat);mb.classList.add('m-only');mb.setAttribute('aria-hidden','true');const pl=pageLabel(d),ids=[s.formNumber?'เลขที่ '+s.formNumber:'',s.branch||''].filter(Boolean).join(' · ');file.append(name);if(pl)file.append(el('span','pageno',pl));if(ids)file.append(el('div','sub',ids));file.append(el('div','sub',when(d.createdAt)),mb);tr.append(file,cell(s.customerName,'c-name'),cell(s.gender),cell(s.nationality));
const treat=el('td','c-treat'),dur=el('td','c-dur num');lines(treat,ts.map(t=>t.name));lines(dur,ts.map(t=>t.duration));tr.append(treat,dur,cell(s.therapist),cell(s.room,'mono'));
const st=el('td','c-status');st.append(badge(cat));const note=statusNote(d,cat,s);if(note){const n=el('div','sub'+(cat==='failed'?' err':''),note);if(cat==='failed'&&d.errorMessage)n.title=str(d.errorMessage);st.append(n);}tr.append(st);
tr.append(cell(typeof s.minConfidence==='number'?pct(s.minConfidence):'','c-conf mono num'));
const act=el('td','c-act'),box=el('div','acts');
if(cat==='review')box.append(actionButton('ตรวจสอบ','primary sm','review',d));else if(cat==='succeeded'||cat==='confirmed')box.append(actionButton('ดู / แก้ไข','sm','review',d));else if(quarantined)box.append(el('span','sub','กรุณาอัปโหลดไฟล์ใหม่'));else if(cat==='failed'){if(upper==='FAILED')box.append(actionButton('ลองอีกครั้ง','sm','retry',d));box.append(actionButton('ดูต้นฉบับ','sm ghost','review',d));}else box.append(el('span','sub','รอผลการอ่าน'));
act.append(box);tr.append(act);return tr;}
function renderRows(){const body=$('rows');const active=document.activeElement;const focusKey=active&&body.contains(active)?active.getAttribute('data-key'):null;body.replaceChildren(...state.docs.map(row));
renderParentChip();const empty=$('empty');if(state.docs.length){empty.hidden=true;}else{const filtered=!!(state.q||state.status||state.batchFilter||state.parentFilter);empty.replaceChildren(el('p','empty-title',filtered?'ไม่พบเอกสารที่ตรงกับตัวกรอง':'ยังไม่มีเอกสาร'),el('p','sub',filtered?'ลองเปลี่ยนคำค้นหา สถานะ หรือชุดอัปโหลด':'อัปโหลดแบบฟอร์มเพื่อเริ่มอ่านข้อมูล'));if(filtered)empty.append(btn('ล้างตัวกรอง','sm',clearFilters));empty.hidden=false;}
const from=state.total&&state.docs.length?state.offset+1:0,to=state.offset+state.docs.length;$('range').textContent=state.total?from+'–'+to+' จาก '+state.total+' เอกสาร':'';$('prev').disabled=state.offset===0;$('next').disabled=state.offset+PAGE>=state.total;
if(focusKey){const f=body.querySelector('[data-key="'+CSS.escape(focusKey)+'"]');if(f)f.focus({preventScroll:true});}}
function listUrl(){const p=new URLSearchParams({limit:String(PAGE),offset:String(state.offset)});if(state.status)p.set('status',state.status);if(state.q)p.set('q',state.q);if(state.batchFilter)p.set('batchId',state.batchFilter);if(state.parentFilter)p.set('parentId',state.parentFilter);return '/api/documents?'+p.toString();}
function renderParentChip(){const c=$('parent-chip');c.hidden=!state.parentFilter;if(state.parentFilter){const t=$('parent-chip-text');t.replaceChildren(document.createTextNode('แสดงเฉพาะหน้าของ '),el('strong',null,state.parentName||'ไฟล์ PDF ที่เลือก'));}}
/* Lists the pages of one PDF (from the drawer of a page or of the SPLIT parent). */
async function showPages(parentId,name){if(!UUID.test(parentId))return;if($('drawer').open){if(state.saving||!(await confirmDiscard()))return;const dlg=$('drawer');finishClose();if(dlg.open)dlg.close();}state.parentFilter=parentId;state.parentName=name||'';state.q='';state.status='';$('q').value='';$('status').value='';state.offset=0;renderParentChip();loadDocuments();$('docs-title').focus();}
async function loadDocuments(){const seq=++state.listSeq;if(state.listAbort)state.listAbort.abort();const ctrl=new AbortController();state.listAbort=ctrl;
try{const data=await getJson(listUrl(),{signal:ctrl.signal});if(seq!==state.listSeq)return;const docs=Array.isArray(data.documents)?data.documents.filter(d=>isObj(d)&&typeof d.documentId==='string'):[];const total=typeof data.total==='number'?data.total:docs.length;
if(!docs.length&&total>0&&state.offset>0){state.offset=Math.max(0,Math.floor((total-1)/PAGE)*PAGE);return loadDocuments();}
state.docs=docs;state.total=total;state.loaded=true;renderParentChip();$('updated').textContent='อัปเดตล่าสุด '+timeFmt.format(new Date());const sig=JSON.stringify([docs,total,state.offset]);if(sig!==state.listSig){state.listSig=sig;renderRows();}syncDrawer();}
catch(e){if(e&&e.name==='AbortError')return;if(seq!==state.listSeq)return;if(!state.loaded){const empty=$('empty');empty.replaceChildren(el('p','empty-title','โหลดรายการเอกสารไม่สำเร็จ'),el('p','sub',e.message),btn('ลองอีกครั้ง','sm',()=>loadDocuments()));empty.hidden=false;}else notify(e.message,'error');}
finally{if(state.listAbort===ctrl)state.listAbort=null;}}
function clearFilters(){state.q='';state.status='';state.batchFilter='';state.parentFilter='';state.parentName='';$('q').value='';$('status').value='';$('batch-filter').value='';state.offset=0;loadDocuments();}
async function retryDocument(id,button){if(button)button.disabled=true;try{await getJson('/api/documents/'+encodeURIComponent(id)+'/retry',{method:'POST'});notify('ส่งเอกสารกลับเข้าคิวอ่านใหม่แล้ว');refreshSoon(0);return true;}catch(e){notify(e.message,'error');if(button)button.disabled=false;return false;}}

/* ---------- batches ---------- */
function batchName(b){return (b.label?b.label+' · ':'')+when(b.createdAt)+' · '+(Number(b.expectedTotal)||0)+' ไฟล์';}
function renderBatchOptions(){const sel=$('batch-filter');const cur=state.batchFilter;sel.replaceChildren(new Option('ทุกชุดอัปโหลด',''));state.batches.forEach(b=>sel.append(new Option(batchName(b),b.batchId)));if(cur&&!state.batches.some(b=>b.batchId===cur))sel.append(new Option('ชุดที่เลือก',cur));sel.value=cur;}
async function loadBatches(){try{const data=await getJson('/api/batches?limit=20');state.batches=(Array.isArray(data.batches)?data.batches:[]).filter(b=>isObj(b)&&typeof b.batchId==='string').sort((a,b)=>String(b.createdAt).localeCompare(String(a.createdAt)));renderBatchOptions();if(!state.batchId&&state.batches.length){state.batchId=state.batches[0].batchId;state.batch=state.batches[0];renderBatch();}}catch(e){}}
async function loadBatch(){if(!state.batchId)return;const id=state.batchId;try{const b=await getJson('/api/batches/'+encodeURIComponent(id));if(id!==state.batchId||!isObj(b))return;state.batch=b;renderBatch();}catch(e){if(e.status===404&&id===state.batchId){state.batchId=null;state.batch=null;renderBatch();}}}
function localPending(batchId){return state.uploads.some(u=>u.group&&u.group.batchId===batchId&&(u.status==='waiting'||u.status==='uploading'));}
function renderBatch(){const box=$('batch'),b=state.batch;if(!b){box.hidden=true;return;}box.hidden=false;const n=k=>typeof b[k]==='number'&&isFinite(b[k])?b[k]:0;
/* expectedTotal/uploaded count FILES; the other counters count ROWS (a PDF becomes one row per page). Rows still to come: pages not created yet and files not uploaded yet. */
const expected=n('expectedTotal'),uploaded=n('uploaded'),rows=has(b,'rows')?n('rows'):uploaded,pages=n('pages'),pagesExpected=n('pagesExpected'),splitting=n('splitting');
const completed=n('completed'),inFlight=n('queued')+n('processing'),pending=localPending(b.batchId),done=typeof b.finished==='boolean'?b.finished:expected>0&&completed>=expected;
const total=Math.max(1,done?rows:has(b,'rowsExpected')?n('rowsExpected'):rows+Math.max(0,pagesExpected-pages)+Math.max(0,expected-uploaded));
/* Files rejected before upload (or abandoned) never reach the server: once nothing is left to upload, retry or read, the batch is settled. */const retryable=state.uploads.some(u=>u.group&&u.group.batchId===b.batchId&&u.status==='failed'&&u.retryable),settled=!done&&!pending&&!retryable&&inFlight===0&&uploaded>0&&completed>=rows;
/* Batch clock (D11): a retry into an idle batch opens a new round and the clock counts from that round's first claim.
   While the reopened round waits for its claim (it may sit ~40 min behind another batch) the start is unknown, so both
   cells show '—'. Falling back to createdAt here is exactly the Release 1 symptom: hours of elapsed time and a rate near 0. */
const reopened=!!b.roundOpenedAt,waiting=reopened&&!b.roundStartedAt,counted=reopened?n('roundCompleted'):completed;
const started=Date.parse(b.roundStartedAt||b.createdAt);
const elapsed=waiting?null:typeof b.durationMs==='number'?b.durationMs:(inFlight>0||pending)&&isFinite(started)?Date.now()-started:null;
const rate=waiting?null:typeof b.throughputPerMinute==='number'?b.throughputPerMinute:elapsed&&counted>0?counted/(elapsed/60000):null;
$('batch-title').textContent=done?'ชุดอัปโหลดล่าสุด · อ่านครบแล้ว':splitting>0?'ชุดอัปโหลดล่าสุด · กำลังแยก PDF เป็นรายหน้า':settled?'ชุดอัปโหลดล่าสุด · อ่านครบทุกไฟล์ที่อัปโหลดได้':'ชุดอัปโหลดล่าสุด · กำลังดำเนินการ';
const missing=expected-uploaded;$('batch-meta').textContent=[b.label||'','เริ่ม '+when(b.createdAt),reopened?(waiting?'รอเริ่มอ่านรอบใหม่':'รอบอ่านใหม่ เริ่ม '+when(b.roundStartedAt)):'','ไฟล์ '+uploaded+'/'+expected,pagesExpected>0?(splitting>0?'กำลังแยกหน้า ':'หน้า PDF ')+pages+'/'+pagesExpected:'','อ่านเสร็จ '+completed+' จาก '+total+' แถว',missing>0&&!pending?'อัปโหลดไม่ครบ '+missing+' ไฟล์':''].filter(Boolean).join(' · ');
const segs=[['confirmed',n('confirmed')],['succeeded',Math.max(0,n('succeeded')-n('confirmed'))],['review',n('needsReview')],['failed',n('failed')],['processing',n('processing')],['queued',n('queued')]];const bar=$('batch-bar');bar.replaceChildren(...segs.filter(s=>s[1]>0).map(s=>{const x=el('span','seg-'+s[0]);x.style.width=(s[1]/total*100)+'%';return x;}));bar.setAttribute('aria-label','อ่านเสร็จ '+completed+' จาก '+total+' แถว');
const stats=[['ทั้งหมด (แถว)',total,''],['รอคิว',n('queued'),'queued'],['กำลังอ่าน',n('processing'),'processing'],['อ่านสำเร็จ',n('succeeded'),'succeeded'],['รอตรวจสอบ',n('needsReview'),'review'],['ไม่สำเร็จ',n('failed'),'failed'],['ยืนยันแล้ว',n('confirmed'),'confirmed'],['เวลาที่ใช้',clock(elapsed),''],['หน้า/นาที',rate===null||!isFinite(rate)?'—':rate.toFixed(1),'']];
$('batch-stats').replaceChildren(...stats.map(s=>{const g=el('div','stat'),dt=el('dt');if(s[2])dt.append(el('span','dot k-'+s[2]));dt.append(document.createTextNode(s[0]));g.append(dt,el('dd',null,s[1]));return g;}));}

/* ---------- uploads ---------- */
function mimeOf(file){if(ALLOWED.includes(file.type))return file.type;const m=/\.([a-z0-9]+)$/i.exec(file.name||'');const ext=m?m[1].toLowerCase():'';return has(EXT,ext)?EXT[ext]:'';}
function uuid(){const b=new Uint8Array(16);crypto.getRandomValues(b);b[6]=(b[6]&15)|64;b[8]=(b[8]&63)|128;const h=Array.from(b,x=>x.toString(16).padStart(2,'0')).join('');return h.slice(0,8)+'-'+h.slice(8,12)+'-'+h.slice(12,16)+'-'+h.slice(16,20)+'-'+h.slice(20);}
function nameProblem(name){const v=String(name||'').normalize('NFC').replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g,'')||'untitled';if(Array.from(v).length>MAX_NAME_CHARS)return ERRORS.FILENAME_TOO_LONG;if(new TextEncoder().encode(v).length>MAX_NAME_BYTES)return ERRORS.FILENAME_TOO_LARGE;return '';}
/* The server rejects these deterministically: they are never uploaded and never counted in the batch total. */function fileProblem(f){if(!mimeOf(f))return 'ไม่รองรับไฟล์ประเภทนี้';if(!f.size)return 'ไฟล์ว่าง (0 ไบต์)';if(f.size>MAX_BYTES)return ERRORS.PAYLOAD_TOO_LARGE+' (สูงสุด 200 MB)';return nameProblem(f.name);}
function addFiles(list){const files=Array.from(list||[]);if(!files.length)return;if(files.length>MAX_FILES){notify('เลือกได้ครั้งละไม่เกิน '+MAX_FILES+' ไฟล์ (คุณเลือก '+files.length+' ไฟล์) กรุณาแบ่งเลือกเป็นหลายครั้ง ไฟล์ชุดแรกยังอัปโหลดต่อได้ระหว่างเลือกชุดถัดไป','error');return;}
const problems=files.map(fileProblem),ok=files.filter((f,i)=>!problems[i]),bad=files.length-ok.length;const group=ok.length?{batchId:null,promise:null,total:ok.length}:null;
files.forEach((f,i)=>{state.uploads.push(problems[i]?{file:f,type:'',group:null,key:'',status:'rejected',progress:0,error:problems[i],retryable:false}:{file:f,type:mimeOf(f),group,key:uuid(),status:'waiting',progress:0,error:'',retryable:true});});
renderUploads();if(!ok.length){notify('ไม่มีไฟล์ที่อัปโหลดได้ (ใช้ได้เฉพาะ PNG, JPG, WebP และ PDF ที่ไม่ว่างและไม่เกิน 200 MB) ดูเหตุผลในรายการอัปโหลด','error');return;}notify('เพิ่ม '+ok.length+' ไฟล์เข้าคิวอัปโหลดแล้ว'+(bad?' · ข้ามไฟล์ที่ใช้ไม่ได้ '+bad+' ไฟล์':'')+(ok.some(f=>mimeOf(f)==='application/pdf')?' · '+PDF_NOTE:''));pump();schedule();}
function ensureBatch(g){if(g.batchId)return Promise.resolve(g.batchId);if(!g.promise){g.promise=postJson('/api/batches',{total:g.total}).then(b=>{if(!isObj(b)||typeof b.batchId!=='string')throw apiError(500,'');g.batchId=b.batchId;state.batchId=b.batchId;state.batch=b;renderBatch();loadBatches();return b.batchId;}).finally(()=>{g.promise=null;});}return g.promise;}
function send(u,batchId,retried){return new Promise((resolve,reject)=>{const x=new XMLHttpRequest();state.xhrs.add(x);x.open('POST','/api/documents');x.timeout=300000;x.setRequestHeader('Content-Type',u.type);x.setRequestHeader('X-CSRF-Token',state.csrf);x.setRequestHeader('X-Batch-Id',batchId);x.setRequestHeader('X-Upload-Filename',encodeURIComponent(u.file.name));x.setRequestHeader('X-Upload-Filename-Encoding','uri');x.setRequestHeader('Idempotency-Key',u.key);
x.upload.addEventListener('progress',e=>{if(e.lengthComputable&&e.total>0){u.progress=Math.min(99,Math.round(e.loaded/e.total*100));paintUpload(u);}});
x.addEventListener('error',()=>{state.xhrs.delete(x);reject(apiError(0,'NETWORK'));});x.addEventListener('timeout',()=>{state.xhrs.delete(x);reject(apiError(0,'TIMEOUT'));});
x.addEventListener('abort',()=>{state.xhrs.delete(x);reject(apiError(0,'USER_CHANGED'));});
x.addEventListener('load',()=>{state.xhrs.delete(x);let data={};try{data=JSON.parse(x.responseText||'{}');}catch(e){}const code=data&&typeof data.error==='string'?data.error:'';
/* The upload waits for the login instead of failing; the Idempotency-Key it already carries makes the resend safe. */
if(!retried&&(x.status===401||(x.status===403&&code==='CSRF_REJECTED'))){u.status='authwait';u.error='';paintUpload(u);
resolve((x.status===401?requireLogin():refreshSession()).then(()=>{u.status='uploading';paintUpload(u);return send(u,batchId,true);}));return;}
if(x.status>=200&&x.status<300){setConnection('ok');resolve(data);return;}reject(apiError(x.status,code));});
x.send(u.file);});}
function start(u){u.status='uploading';u.progress=0;u.error='';state.active++;paintUpload(u);
ensureBatch(u.group).catch(e=>{e.batchFailure=true;throw e;}).then(id=>send(u,id,false)).then(res=>{u.status='done';u.progress=100;u.documentId=isObj(res)&&typeof res.documentId==='string'?res.documentId:null;})
.catch(e=>{if(e&&e.code==='USER_CHANGED')return;u.status='failed';u.error=(e&&e.message)||'อัปโหลดไม่สำเร็จ';u.retryable=!FINAL_UPLOAD_ERRORS.includes(e&&e.code);if(e&&e.batchFailure){u.error='สร้างชุดอัปโหลดไม่สำเร็จ: '+u.error;state.uploads.forEach(o=>{if(o.group===u.group&&o.status==='waiting'){o.status='failed';o.error=u.error;o.retryable=true;paintUpload(o);}});}})
.finally(()=>{state.active--;paintUpload(u);refreshSoon(800);pump();});}
function pump(){if(!state.leaving)while(state.active<CONCURRENCY){const u=state.uploads.find(x=>x.status==='waiting');if(!u)break;start(u);}summarizeUploads();}
function retryUpload(u){if(u.status!=='failed'||!u.retryable)return;u.status='waiting';u.error='';paintUpload(u);pump();schedule();}
function buildUploadRow(u){const row=el('div','up-row'),name=el('span','up-name mono',u.file.name);name.title=u.file.name;const st=el('span','up-state'),bar=el('span','bar'),fill=el('span','fill'),act=el('span','up-act');bar.append(fill);bar.setAttribute('role','progressbar');bar.setAttribute('aria-valuemin','0');bar.setAttribute('aria-valuemax','100');bar.setAttribute('aria-label','ความคืบหน้า '+u.file.name);row.append(name,el('span','up-size sub mono',size(u.file.size)),st,bar,act);u.row=row;u.view={st,bar,fill,act};}
function paintUpload(u){if(!u.view)return;const v=u.view;const text=u.status==='waiting'?'รออัปโหลด':u.status==='authwait'?'รอเข้าสู่ระบบ':u.status==='uploading'?'กำลังอัปโหลด '+u.progress+'%':u.status==='done'?'อัปโหลดแล้ว · เข้าคิวอ่าน':u.status==='cancelled'?(u.error||'ยกเลิก'):(u.error||'อัปโหลดไม่สำเร็จ');v.st.textContent=text;v.st.className='up-state s-'+u.status;const p=u.status==='done'?100:u.status==='uploading'?u.progress:0;v.fill.style.width=p+'%';v.bar.setAttribute('aria-valuenow',String(p));v.bar.style.visibility=u.status==='waiting'||u.status==='uploading'||u.status==='authwait'?'visible':'hidden';
const wantRetry=u.status==='failed'&&u.retryable;if(wantRetry!==!!v.act.firstChild)v.act.replaceChildren(...(wantRetry?[btn('ลองใหม่','sm',()=>retryUpload(u),'ลองอัปโหลด '+u.file.name+' อีกครั้ง')]:[]));summarizeUploads();}
function renderUploads(){$('uploads').hidden=!state.uploads.length;$('up-list').replaceChildren(...state.uploads.map(u=>{if(!u.row)buildUploadRow(u);paintUpload(u);return u.row;}));summarizeUploads();}
function summarizeUploads(){const c={waiting:0,uploading:0,authwait:0,done:0,failed:0,rejected:0,cancelled:0};let retry=0;state.uploads.forEach(u=>{c[u.status]++;if(u.status==='failed'&&u.retryable)retry++;});const accepted=state.uploads.length-c.rejected;
const parts=['อัปโหลดแล้ว '+c.done+' จาก '+accepted+' ไฟล์'];if(c.uploading)parts.push('กำลังส่ง '+c.uploading);if(c.waiting)parts.push('รอคิว '+c.waiting);if(c.authwait)parts.push('รอเข้าสู่ระบบ '+c.authwait);if(c.failed)parts.push('ไม่สำเร็จ '+c.failed);if(c.cancelled)parts.push('ยกเลิก '+c.cancelled);if(c.rejected)parts.push('ข้าม '+c.rejected);$('up-summary').textContent=parts.join(' · ');
const r=$('up-retry');r.hidden=!retry;r.textContent='ลองใหม่ทั้งหมด ('+retry+')';$('up-clear').hidden=!(c.done||c.rejected||c.cancelled||(c.failed-retry));}
function clearUploads(){state.uploads=state.uploads.filter(u=>u.status==='waiting'||u.status==='uploading'||u.status==='authwait'||(u.status==='failed'&&u.retryable));renderUploads();}

/* ---------- polling ---------- */
function drawerOpen(){return $('drawer').open&&!!state.current;}
function isActive(){if(state.active>0||state.uploads.some(u=>u.status==='waiting'))return true;const b=state.batch;if(b&&((Number(b.queued)||0)+(Number(b.processing)||0))>0)return true;if(state.docs.some(d=>{const c=categoryOf(d);return c==='queued'||c==='processing'||d.deliveryStatus==='PENDING'||d.deliveryStatus==='RETRYING';}))return true;return drawerOpen()&&['queued','processing'].includes(categoryOf(state.current));}
function schedule(){clearTimeout(state.timer);state.timer=0;if(state.leaving||document.hidden)return;state.timer=setTimeout(tick,isActive()?3000:15000);}
async function tick(){clearTimeout(state.timer);state.timer=0;if(state.leaving||state.ticking)return;
/* A login is open: polling stops. tick()'s finally is the only thing that re-arms the 3/15 s chain, so an already
   armed timer firing during a login would end it for good — the list would freeze until a manual รีเฟรช. */
if(state.authWait){const wait=state.authWait;if(state.rearm!==wait){state.rearm=wait;wait.then(schedule,()=>undefined);}return;}
state.ticking=true;const jobs=background(()=>[loadDocuments(),loadBatch()]);
try{await Promise.all(jobs);background(()=>pollDrawer());}finally{state.ticking=false;schedule();}}
function refreshSoon(ms){clearTimeout(state.soon);if(state.leaving)return;state.soon=setTimeout(()=>{loadDocuments();loadBatch();},ms);}

/* ---------- review drawer ---------- */
function setUrl(id){try{const u=new URL(location.href);if(id)u.searchParams.set('document',id);else u.searchParams.delete('document');history.replaceState(null,'',u.pathname+u.search+u.hash);}catch(e){}}
function showAlert(text,kind,action){const a=$('d-alert');a.className='d-alert'+(kind==='error'?' is-error':kind==='ok'?' is-ok':'');a.setAttribute('role',kind==='error'?'alert':'status');a.replaceChildren(el('span','d-alert-text',text));if(action)a.append(btn(action.label,'sm',action.run));a.hidden=false;}
function hideAlert(){$('d-alert').hidden=true;}
function setDirty(v){state.dirty=v;const d=$('d-draft');d.className='draft'+(v?' is-dirty':'');d.textContent=v?'มีการแก้ไขที่ยังไม่ได้บันทึก':state.editable?'ยังไม่มีการแก้ไข':state.draft?'ดูได้อย่างเดียว':'';}
function changed(){setDirty(JSON.stringify(state.draft)!==state.originalSig);}
function setInert(on){['d-head','d-alert','d-body','d-foot'].forEach(id=>{const n=$(id);if(on)n.setAttribute('inert','');else n.removeAttribute('inert');});}
function ask(title,text,yes){if(state.askResolve)answer(false);state.askReturn=document.activeElement;$('ask-title').textContent=title;$('ask-text').textContent=text;$('ask-yes').textContent=yes;setInert(true);$('ask').hidden=false;$('ask-no').focus();return new Promise(resolve=>{state.askResolve=resolve;});}
function answer(v){const r=state.askResolve;if(!r)return;state.askResolve=null;$('ask').hidden=true;setInert(false);const back=state.askReturn;state.askReturn=null;if(!v&&back&&document.contains(back))back.focus();r(v);}
function confirmDiscard(){return state.dirty?ask('ทิ้งการแก้ไขที่ยังไม่ได้บันทึก?','ข้อมูลที่คุณแก้ไขในเอกสารนี้จะหายไป และเอกสารจะยังไม่ถูกยืนยัน','ทิ้งการแก้ไข'):Promise.resolve(true);}
function clearPreview(){state.previewSeq++;state.previewMissing=false;if(state.previewAbort){state.previewAbort.abort();state.previewAbort=null;}if(state.blobUrl){URL.revokeObjectURL(state.blobUrl);state.blobUrl='';}$('p-content').replaceChildren();$('p-open').hidden=true;$('p-open').removeAttribute('href');$('z-tools').hidden=true;state.zoom=1;$('z-level').textContent='100%';}
/* A page row links to its page inside the original PDF (the SPLIT parent's content), shown in the preview pane. */
function pageLink(){const b=$('p-pdf'),d=state.current;const on=!!(d&&d.parentDocumentId&&typeof d.pageNumber==='number');b.hidden=!on;if(on)b.textContent=state.pdfView?'กลับไปดูภาพหน้านี้':'เปิด PDF ต้นฉบับ (หน้า '+d.pageNumber+')';}
function toggleOriginal(){const d=state.current;if(!d||!d.parentDocumentId)return;const seq=state.openSeq;clearPreview();state.pdfView=!state.pdfView;pageLink();return state.pdfView?loadPreview(seq,d.parentDocumentId,d.pageNumber):loadPreview(seq,d.documentId);}
function setZoom(z){state.zoom=Math.min(4,Math.max(.25,Math.round(z*100)/100));const img=$('p-content').querySelector('img');if(img)img.style.width=(state.zoom*100)+'%';$('z-level').textContent=Math.round(state.zoom*100)+'%';}
/* The preview of what is open: a load that a newer clearPreview() (toggle, reopen, close) superseded is dropped and its fetch aborted, so a slow original never replaces the preview shown after it, and no blob URL is left unrevoked. */
async function loadPreview(seq,id,page){const box=$('p-content');if(state.current&&String(state.current.status||'').toUpperCase()==='QUARANTINED'){box.replaceChildren(el('p','sub err p-note',ERRORS.DOCUMENT_QUARANTINED));return;}box.replaceChildren(el('p','sub p-note','กำลังโหลดต้นฉบับ…'));
const mine=state.previewSeq,ctl=new AbortController();state.previewAbort=ctl;const live=()=>seq===state.openSeq&&mine===state.previewSeq;
try{const r=await api('/api/documents/'+encodeURIComponent(id)+'/content',{signal:ctl.signal});const raw=await r.blob();if(!live())return;if(state.previewAbort===ctl)state.previewAbort=null;const type=String(raw.type||(state.current&&state.current.mimeType)||'').split(';')[0].trim().toLowerCase();
if(!ALLOWED.includes(type)){box.replaceChildren(el('p','sub p-note','ไม่สามารถแสดงตัวอย่างไฟล์ประเภทนี้ได้'));return;}
if(state.blobUrl)URL.revokeObjectURL(state.blobUrl);state.blobUrl=URL.createObjectURL(new Blob([raw],{type}));const name=(state.current&&state.current.filename)||'เอกสาร';
const at=typeof page==='number'&&page>0?'#page='+page:'';if(type==='application/pdf'){const f=el('iframe');f.title='ต้นฉบับ PDF: '+name+(at?' หน้า '+page:'');f.src=state.blobUrl+at;box.replaceChildren(f);$('z-tools').hidden=true;}else{const img=el('img');img.alt='ภาพต้นฉบับ: '+name;img.decoding='async';img.addEventListener('error',()=>{if(!live())return;box.replaceChildren(el('p','sub p-note','แสดงภาพต้นฉบับไม่ได้ ไฟล์อาจเสียหาย'));$('z-tools').hidden=true;});img.src=state.blobUrl;box.replaceChildren(img);$('z-tools').hidden=false;setZoom(1);}
const open=$('p-open');open.href=state.blobUrl+at;open.hidden=false;}
catch(e){if(!live()||(e&&e.name==='AbortError'))return;if(state.previewAbort===ctl)state.previewAbort=null;if(e.code==='CONTENT_NOT_FOUND')state.previewMissing=true;box.replaceChildren(el('p','sub err p-note','โหลดต้นฉบับไม่ได้: '+(e.code==='CONTENT_NOT_FOUND'?missingText(page):e.message)));}}
/* Why an original is missing: a page whose render failed (Retry re-renders it), a page being re-rendered, else a plain missing file. */
function missingText(page){const d=state.current||{};if(!d.parentDocumentId||typeof page==='number')return ERRORS.CONTENT_NOT_FOUND;const cat=categoryOf(d);if(cat==='failed'&&/^PAGE_RENDER_FAILED/.test(String(d.errorMessage||'')))return 'ยังไม่มีไฟล์ภาพของหน้านี้ (แปลงหน้า PDF เป็นภาพไม่สำเร็จ กด "ลองอ่านอีกครั้ง" เพื่อแปลงใหม่)';if(cat==='queued'||cat==='processing')return 'กำลังแปลงหน้านี้เป็นภาพใหม่ ภาพจะแสดงเมื่อพร้อม';return ERRORS.CONTENT_NOT_FOUND;}
/* null when the document was never confirmed; the reviewer's display name, or the legacy label when it joins to none. */
function reviewerLabel(by,name){if(!by)return null;return str(name)||LEGACY_REVIEWER;}
function fieldValue(sr,sec,key){const f=isObj(sr)&&isObj(sr[sec])?sr[sec][key]:null;return isObj(f)&&f.value!==null&&f.value!==undefined?String(f.value):'';}
function renderHead(){const d=state.current||{},box=$('d-status');box.replaceChildren();if(!d.status&&!d.statusCategory)return;box.append(badge(categoryOf(d)));const ids=[fieldValue(d.structuredResult,'header','formNumber')?'เลขที่ '+fieldValue(d.structuredResult,'header','formNumber'):'',fieldValue(d.structuredResult,'staffOnly','branch')].filter(Boolean).join(' · ');if(ids)box.append(el('span','sub mono',ids));const who=reviewerLabel(d.reviewedBy,d.reviewedByName);if(d.reviewedAt)box.append(el('span','sub',(who?'ยืนยันโดย '+who+' · ':'ยืนยันเมื่อ ')+when(d.reviewedAt)));else if(d.processedAt)box.append(el('span','sub','อ่านเสร็จ '+when(d.processedAt)));if(has(DELIVERY,d.deliveryStatus))box.append(deliveryBadge(d.deliveryStatus));}
function toDraft(sr){const d=JSON.parse(JSON.stringify(sr));SECTIONS.forEach(s=>{if(!isObj(d[s.key]))d[s.key]={};});return d;}
function applyDocument(doc){const was=state.current?categoryOf(state.current):null;state.current=doc;const cat=categoryOf(doc);const waiting=['failed','queued','processing'];if(state.previewMissing&&was!==null&&waiting.includes(was)&&!waiting.includes(cat)){state.pdfView=false;clearPreview();loadPreview(state.openSeq,doc.documentId);}$('d-title').textContent=titleOf(doc);pageLink();/* The server always returns a canonical view (empty sections before OCR), so only reviewable states get an editor. */const reviewable=['review','succeeded','confirmed'].includes(cat);state.draft=reviewable&&isObj(doc.structuredResult)?toDraft(doc.structuredResult):null;state.editable=!!state.draft;state.originalSig=state.draft?JSON.stringify(state.draft):'';setDirty(false);renderHead();renderEditor();$('d-save').disabled=!state.editable;$('d-save').textContent=cat==='confirmed'?'บันทึกการแก้ไข':'บันทึกและยืนยัน';}
async function loadReview(seq){const id=state.current&&state.current.documentId;if(!id)return;try{const data=await getJson('/api/documents/'+encodeURIComponent(id)+'/ocr');if(seq!==state.openSeq)return;if(!data||!isObj(data.document))throw apiError(404,'DOCUMENT_NOT_FOUND');if(state.dirty||state.saving)return;applyDocument(data.document);}catch(e){if(seq!==state.openSeq)return;if(!state.draft){$('editor').replaceChildren(el('p','sub err',e.message));showAlert(e.message,'error');}}}
async function openReview(id,trigger){if(!UUID.test(id)){notify('ไม่พบเอกสารที่ต้องการเปิด','error');setUrl(null);return;}const dlg=$('drawer');
if(dlg.open){if(state.current&&state.current.documentId===id)return;if(state.saving||!(await confirmDiscard()))return;}else state.lastFocus=trigger||document.activeElement;
const seq=++state.openSeq;clearPreview();const listed=state.docs.find(d=>d.documentId===id);state.current=Object.assign({documentId:id},listed||{});state.draft=null;state.editable=false;setDirty(false);hideAlert();$('d-next').hidden=true;state.pdfView=false;$('d-title').textContent=listed&&listed.filename?titleOf(listed):'กำลังโหลด…';pageLink();renderHead();$('editor').replaceChildren(el('p','sub','กำลังโหลดข้อมูล…'));$('d-save').disabled=true;
if(!dlg.open){dlg.showModal();document.body.classList.add('modal-open');}$('d-body').scrollTop=0;$('editor').scrollTop=0;setUrl(id);loadPreview(seq,id);await loadReview(seq);}
async function requestClose(){if(state.saving)return;if(!(await confirmDiscard()))return;const dlg=$('drawer');finishClose();if(dlg.open)dlg.close();}
function finishClose(){state.openSeq++;const id=state.current&&state.current.documentId;clearPreview();state.current=null;state.draft=null;state.editable=false;setDirty(false);hideAlert();document.body.classList.remove('modal-open');setUrl(null);const back=state.lastFocus;state.lastFocus=null;const target=back&&document.contains(back)?back:id?$('rows').querySelector('[data-doc="'+CSS.escape(id)+'"]'):null;if(target)setTimeout(()=>target.focus(),0);}
function syncDrawer(){if(!drawerOpen()||state.saving)return;const d=state.docs.find(x=>x.documentId===state.current.documentId);if(!d)return;const before=categoryOf(state.current),after=categoryOf(d);if(before!==after&&(before==='queued'||before==='processing')&&!state.dirty){loadReview(state.openSeq);return;}if(d.deliveryStatus!==undefined&&d.deliveryStatus!==state.current.deliveryStatus){state.current=Object.assign({},state.current,{deliveryStatus:d.deliveryStatus});renderHead();}}
function pollDrawer(){if(!drawerOpen()||state.dirty||state.saving)return;const cat=categoryOf(state.current);if((cat==='queued'||cat==='processing')&&!state.docs.some(x=>x.documentId===state.current.documentId))loadReview(state.openSeq);}
function nextReview(){const id=state.current&&state.current.documentId;return state.docs.find(d=>d.documentId!==id&&categoryOf(d)==='review')||null;}

/* ---------- editor ---------- */
function flag(){return el('span','flag','ต้องตรวจสอบ');}
function textInput(id,value,editable){const i=el('input');i.type='text';i.id=id;i.value=str(value);i.maxLength=MAX_LEN;i.autocomplete='off';i.spellcheck=false;if(!editable)i.readOnly=true;return i;}
function meta(f,needs,cls){const m=el('div','f-meta'+(cls?' '+cls:''));const raw=f.raw;if(needs||(raw!==null&&raw!==undefined&&str(raw)!==str(f.value))){const r=el('span');r.append(document.createTextNode('OCR อ่านได้ '),el('q',null,raw===null||raw===undefined||raw===''?'(ไม่มีข้อความ)':String(raw)));m.append(r);}
if(typeof f.confidence==='number')m.append(el('span',null,'ความมั่นใจ '+pct(f.confidence)));if(typeof f.source==='string'&&has(SOURCE,f.source))m.append(el('span',null,SOURCE[f.source]));m.append(el('span','edited','· แก้ไขแล้ว'));return m;}
function fieldRow(obj,key,editable){const f=obj[key],wrap=el('div','field'),head=el('div','f-head');
if(!isObj(f)){head.append(el('span','f-label',LABEL[key]||key));wrap.append(head,el('p','missing','ไม่มีช่องนี้ในผลการอ่าน'));return wrap;}
const needs=f.needsReview===true,id='f'+(++state.uid),label=el('label','f-label',LABEL[key]||key);label.htmlFor=id;head.append(label);if(needs){wrap.classList.add('needs');head.append(flag());}
const input=textInput(id,f.value,editable),orig=str(f.value);input.addEventListener('input',()=>{f.value=input.value===''?null:input.value;wrap.classList.toggle('is-edited',input.value!==orig);changed();});state.inputs.set(f,input);
wrap.append(head,input,meta(f,needs,''));return wrap;}
function listBlock(obj,key,editable){const title=LABEL[key]||key,wrap=el('div','field'),head=el('div','f-head'),lid='l'+(++state.uid),lab=el('span','f-label',title);lab.id=lid;head.append(lab);const ul=el('ul','chips');ul.setAttribute('aria-labelledby',lid);wrap.append(head,ul);let add=null;
function paint(focusLast){const arr=Array.isArray(obj[key])?obj[key]:[];const needs=arr.some(it=>isObj(it)&&it.needsReview===true);head.replaceChildren(lab);if(needs)head.append(flag());
const items=arr.map((it,i)=>{if(!isObj(it))return el('li','chip',str(it));const li=el('li','chip'+(it.needsReview===true?' needs':'')),input=textInput('f'+(++state.uid),it.value,editable),orig=str(it.value);input.setAttribute('aria-label',title+' รายการที่ '+(i+1));input.placeholder='ระบุ'+title;input.addEventListener('input',()=>{it.value=input.value===''?null:input.value;li.classList.toggle('is-edited',input.value!==orig);changed();});state.inputs.set(it,input);li.append(input);
if(editable)li.append(btn('ลบ','sm ghost',()=>{arr.splice(i,1);changed();paint(false);if(add)add.focus();},'ลบ '+title+' รายการที่ '+(i+1)+(orig?' ('+orig+')':'')));
if(it.needsReview===true||(it.raw!==null&&it.raw!==undefined&&str(it.raw)!==orig))li.append(meta(it,it.needsReview===true,''));if(focusLast&&i===arr.length-1)setTimeout(()=>input.focus(),0);return li;});
ul.replaceChildren(...(items.length?items:[el('li','chip-empty','ไม่มีรายการ')]));if(add)add.disabled=arr.length>=MAX_ITEMS;}
if(editable){add=btn('+ เพิ่มรายการ','sm',()=>{if(!Array.isArray(obj[key]))obj[key]=[];if(obj[key].length>=MAX_ITEMS)return;obj[key].push({raw:null,value:null,checked:true,confidence:null,source:'human',needsReview:false});changed();paint(true);},'เพิ่มรายการใน'+title);wrap.append(add);}
paint(false);return wrap;}
function treatmentBlock(obj,key,editable){const wrap=el('div','field'),head=el('div','f-head'),lab=el('span','f-label',LABEL[key]),list=el('div');head.append(lab);wrap.append(head,list);let add=null;
function paint(focusLast){const arr=Array.isArray(obj[key])?obj[key]:[];head.replaceChildren(lab);if(arr.some(t=>isObj(t)&&t.needsReview===true))head.append(flag());
const cards=arr.filter(isObj).map((t,i)=>{const needs=t.needsReview===true,card=el('div','t-item'+(needs?' needs':'')),th=el('div','t-head');th.append(el('strong',null,'ทรีตเมนต์ที่ '+(i+1)));if(needs)th.append(flag());if(editable)th.append(btn('ลบ','sm ghost',()=>{arr.splice(arr.indexOf(t),1);changed();paint(false);if(add)add.focus();},'ลบทรีตเมนต์ที่ '+(i+1)));
const grid=el('div','t-grid'),ln=el('label',null,'ชื่อทรีตเมนต์'),ld=el('label',null,'ระยะเวลา'),iname=textInput('f'+(++state.uid),t.value,editable),idur=textInput('f'+(++state.uid),t.duration,editable),on=str(t.value),od=str(t.duration);iname.placeholder='เช่น นวดไทย';idur.placeholder='เช่น 90 นาที';
const mark=()=>card.classList.toggle('is-edited',iname.value!==on||idur.value!==od);iname.addEventListener('input',()=>{t.value=iname.value===''?null:iname.value;mark();changed();});idur.addEventListener('input',()=>{t.duration=idur.value===''?null:idur.value;mark();changed();});state.inputs.set(t,iname);
ln.append(iname);ld.append(idur);grid.append(ln,ld);const tm=meta(t,needs,'t-meta');if(typeof t.guests==='number')tm.append(el('span',null,'ลูกค้า '+t.guests+' คน'));card.append(th,grid,tm);if(focusLast&&i===arr.length-1)setTimeout(()=>iname.focus(),0);return card;});
list.replaceChildren(...(cards.length?cards:[el('p','missing','ไม่มีรายการทรีตเมนต์')]));if(add)add.disabled=arr.length>=MAX_ITEMS;}
if(editable){add=btn('+ เพิ่มทรีตเมนต์','sm',()=>{if(!Array.isArray(obj[key]))obj[key]=[];if(obj[key].length>=MAX_ITEMS)return;obj[key].push({raw:null,nameRaw:null,value:null,duration:null,durationMinutes:null,confidence:null,source:'human',needsReview:false});changed();paint(true);});wrap.append(add);}
paint(false);return wrap;}
function sectionBlock(sec){const box=el('section','group'),id='g'+(++state.uid),h=el('h3','group-title',sec.title);h.id=id;box.setAttribute('aria-labelledby',id);box.append(h);const obj=state.draft[sec.key];
if(!Object.keys(obj).length&&sec.key!=='staffOnly'){box.append(el('p','missing','ไม่มีข้อมูลส่วนนี้ในผลการอ่าน (อาจเป็นเอกสารที่อ่านด้วยระบบรุ่นก่อน)'));return box;}
sec.fields.forEach(f=>{if(f[2]&&!isObj(obj[f[0]]))return;box.append(f[1]==='field'?fieldRow(obj,f[0],state.editable):f[1]==='list'?listBlock(obj,f[0],state.editable):treatmentBlock(obj,f[0],state.editable));});
if(sec.key==='staffOnly'&&typeof obj.totalMinutes==='number')box.append(el('p','sub','เวลารวมที่เขียนไว้ในฟอร์ม '+obj.totalMinutes+' นาที'));return box;}
function countNeeds(){let n=0;SECTIONS.forEach(sec=>{const obj=state.draft[sec.key]||{};sec.fields.forEach(f=>{const v=obj[f[0]];if(Array.isArray(v))v.forEach(it=>{if(isObj(it)&&it.needsReview===true)n++;});else if(isObj(v)&&v.needsReview===true)n++;});});return n;}
function jumpNext(){const all=Array.from($('editor').querySelectorAll('.field.needs,.chip.needs,.t-item.needs'));if(!all.length)return;const a=document.activeElement;const next=all.find(n=>a&&!n.contains(a)&&(n.compareDocumentPosition(a)&Node.DOCUMENT_POSITION_PRECEDING))||all[0];next.scrollIntoView({block:'center',behavior:reduced()?'auto':'smooth'});const i=next.querySelector('input');if(i)i.focus({preventScroll:true});}
function rawBlock(d){const det=el('details','raw-json'),pre=el('pre');det.append(el('summary',null,'ข้อมูลดิบจากระบบอ่าน (JSON)'),pre);det.addEventListener('toggle',()=>{if(det.open&&!pre.firstChild)pre.textContent=d.rawResponse===undefined||d.rawResponse===null?'ไม่มีข้อมูลดิบ':JSON.stringify(d.rawResponse,null,2);});return det;}
function pagesPanel(d){const p=el('div','panel');if(categoryOf(d)==='split'){p.append(el('p',null,'ไฟล์นี้ถูกแยกเป็น '+(typeof d.pageCount==='number'?d.pageCount+' ':'')+'หน้า แต่ละหน้าเป็นหนึ่งแถวในตาราง'),btn('ดูทุกหน้า','sm primary',()=>showPages(d.documentId,d.filename)));return p;}
p.append(el('p',null,(d.parentFilename||d.filename||'ไฟล์ PDF')+' · '+pageLabel(d)),btn('ดูทุกหน้าของไฟล์นี้','sm',()=>showPages(d.parentDocumentId,d.parentFilename||d.filename)));return p;}
function pendingPanel(d,cat){const p=el('div','panel');if(cat==='split')return pagesPanel(d);if(cat==='failed'){p.append(el('p',null,'อ่านเอกสารไม่สำเร็จ · '+failText(d)));if(String(d.status||'').toUpperCase()==='FAILED')p.append(btn('ลองอ่านอีกครั้ง','sm primary',async e=>{const seq=state.openSeq;if(await retryDocument(d.documentId,e.currentTarget)&&seq===state.openSeq)loadReview(seq);}));}
else if(cat==='queued'||cat==='processing')p.append(el('p',null,cat==='queued'?'เอกสารอยู่ในคิวรออ่าน ข้อมูลจะแสดงที่นี่เมื่ออ่านเสร็จ (อัปเดตอัตโนมัติ)':'ระบบกำลังอ่านเอกสารนี้ ข้อมูลจะแสดงที่นี่เมื่ออ่านเสร็จ (อัปเดตอัตโนมัติ)'));else p.append(el('p',null,'ยังไม่มีข้อมูลจากการอ่านเอกสารนี้'));return p;}
function summaryPanel(cat){const n=countNeeds(),p=el('div','panel'+(n?' needs':''));if(!state.editable)p.append(el('p',null,'แก้ไขเอกสารนี้ไม่ได้ในสถานะปัจจุบัน'));else if(n){p.append(el('p',null,'มี '+n+' ช่องที่ระบบไม่แน่ใจ กรุณาเทียบกับต้นฉบับ แก้ไขถ้าจำเป็น แล้วกดบันทึกและยืนยัน'),btn('ไปยังช่องที่ต้องตรวจ','sm',jumpNext));}else p.append(el('p',null,cat==='confirmed'?'เอกสารนี้ยืนยันแล้ว หากพบข้อผิดพลาดให้แก้ไขแล้วกดบันทึกอีกครั้ง':'ไม่มีช่องที่ระบบไม่แน่ใจ ตรวจทานแล้วกดบันทึกและยืนยัน'));return p;}
function renderEditor(){const root=$('editor'),d=state.current||{},cat=categoryOf(d);state.inputs=new WeakMap();const page=d.parentDocumentId?[pagesPanel(d)]:[];if(!state.draft){root.replaceChildren(pendingPanel(d,cat),...page,rawBlock(d));return;}root.replaceChildren(summaryPanel(cat),...page,...SECTIONS.filter(sec=>!sec.optional||Object.keys(state.draft[sec.key]||{}).length>0).map(sectionBlock),rawBlock(d));}
function validate(){const blank=(v)=>str(v).trim()==='';for(const sec of SECTIONS){const obj=state.draft[sec.key]||{};for(const f of sec.fields){const arr=obj[f[0]];if(!Array.isArray(arr))continue;if(arr.length>MAX_ITEMS)return {msg:(LABEL[f[0]]||f[0])+' มีได้ไม่เกิน '+MAX_ITEMS+' รายการ'};for(const it of arr){if(!isObj(it)||(it.raw!==null&&it.raw!==undefined))continue;if(blank(it.value)&&(f[1]!=='treatments'||blank(it.duration)))return {msg:'มีรายการที่เพิ่มไว้แต่ยังว่างใน '+(LABEL[f[0]]||f[0])+' กรุณากรอกหรือลบออกก่อนบันทึก',input:state.inputs.get(it)};}}}return null;}
function setBusy(on){['d-save','d-cancel','d-close','d-next'].forEach(id=>{$(id).disabled=on||(id==='d-save'&&!state.editable);});}
async function save(){if(state.saving||!state.editable||!state.draft||!state.current)return;const problem=validate();if(problem){showAlert(problem.msg,'error');if(problem.input)problem.input.focus();return;}
const seq=state.openSeq,id=state.current.documentId,body={structuredResult:state.draft};if(typeof state.current.updatedAt==='string')body.expectedUpdatedAt=state.current.updatedAt;state.saving=true;setBusy(true);$('d-body').setAttribute('inert','');showAlert('กำลังบันทึก…','');
try{const res=await postJson('/api/documents/'+encodeURIComponent(id)+'/ocr/review',body);if(seq!==state.openSeq)return;state.saving=false;if(isObj(res.document))applyDocument(res.document);else{state.originalSig=JSON.stringify(state.draft);setDirty(false);}
const n=typeof res.corrections==='number'?res.corrections:0;showAlert('ยืนยันข้อมูลแล้ว · '+(n?'แก้ไข '+n+' ช่อง':'ไม่มีการแก้ไข')+' · '+(res.delivery==='PENDING'?'กำลังส่งการแก้ไขให้ AI เรียนรู้ (ทำงานเบื้องหลัง)':'ไม่มีการแก้ไขที่ต้องส่งให้ AI'),'ok');const nx=nextReview();$('d-next').hidden=!nx;refreshSoon(0);}
catch(e){if(seq!==state.openSeq)return;if(e.code==='REVIEW_CONFLICT')showAlert('มีผู้อื่นบันทึกเอกสารนี้หลังจากที่คุณเปิด การแก้ไขของคุณยังอยู่ในหน้านี้และยังไม่ถูกบันทึก — โหลดข้อมูลล่าสุดเพื่อตรวจสอบก่อนแก้ไขอีกครั้ง','error',{label:'โหลดข้อมูลล่าสุด',run:async()=>{if(state.dirty&&!(await ask('โหลดข้อมูลล่าสุด?','การแก้ไขที่ยังไม่ได้บันทึกของคุณจะถูกแทนที่ด้วยข้อมูลล่าสุดจากระบบ','โหลดข้อมูลล่าสุด')))return;setDirty(false);hideAlert();loadReview(state.openSeq);}});
else showAlert(e.message+' · การแก้ไขของคุณยังอยู่ ลองบันทึกอีกครั้งได้','error');}
finally{state.saving=false;setBusy(false);if(!state.askResolve)$('d-body').removeAttribute('inert');}}

/* ---------- wiring ---------- */
function wire(){const files=$('files'),drop=$('drop'),dlg=$('drawer');
[$('pick'),$('pick2')].forEach(b=>b.addEventListener('click',()=>files.click()));files.addEventListener('change',()=>{addFiles(files.files);files.value='';});
const hasFiles=e=>!!(e.dataTransfer&&Array.from(e.dataTransfer.types||[]).includes('Files'));
const busyUi=()=>dlg.open||modalOpen();
document.addEventListener('dragover',e=>{if(!hasFiles(e))return;e.preventDefault();if(!busyUi())drop.classList.add('drag');});document.addEventListener('dragleave',e=>{if(!e.relatedTarget)drop.classList.remove('drag');});document.addEventListener('drop',e=>{if(!hasFiles(e))return;e.preventDefault();drop.classList.remove('drag');if(!busyUi())addFiles(e.dataTransfer.files);});
$('up-retry').addEventListener('click',()=>{state.uploads.forEach(u=>{if(u.status==='failed'&&u.retryable){u.status='waiting';u.error='';paintUpload(u);}});pump();schedule();});$('up-clear').addEventListener('click',clearUploads);
$('q').addEventListener('input',()=>{clearTimeout(state.searchTimer);state.searchTimer=setTimeout(()=>{const v=$('q').value.trim().slice(0,100);if(v===state.q)return;state.q=v;state.offset=0;loadDocuments();},300);});
$('q').addEventListener('keydown',e=>{if(e.key==='Enter'){clearTimeout(state.searchTimer);state.q=$('q').value.trim().slice(0,100);state.offset=0;loadDocuments();}});
$('status').addEventListener('change',()=>{state.status=$('status').value;state.offset=0;loadDocuments();});$('batch-filter').addEventListener('change',()=>{state.batchFilter=$('batch-filter').value;state.offset=0;loadDocuments();});
$('reload').addEventListener('click',()=>{loadBatches();tick();});$('prev').addEventListener('click',()=>{state.offset=Math.max(0,state.offset-PAGE);loadDocuments().then(()=>$('docs-title').focus());});$('next').addEventListener('click',()=>{if(state.offset+PAGE<state.total){state.offset+=PAGE;loadDocuments().then(()=>$('docs-title').focus());}});
$('batch-view').addEventListener('click',()=>{if(!state.batchId)return;state.batchFilter=state.batchId;renderBatchOptions();state.status='';state.parentFilter='';state.parentName='';renderParentChip();$('status').value='';state.offset=0;loadDocuments();$('docs-title').scrollIntoView({block:'start',behavior:reduced()?'auto':'smooth'});});
$('rows').addEventListener('click',e=>{const b=e.target instanceof Element?e.target.closest('button[data-action]'):null;if(!b)return;const id=b.getAttribute('data-doc')||'';if(b.getAttribute('data-action')==='retry')retryDocument(id,b);else openReview(id,b);});
$('p-pdf').addEventListener('click',()=>{toggleOriginal();});$('parent-clear').addEventListener('click',()=>{state.parentFilter='';state.parentName='';state.offset=0;renderParentChip();loadDocuments();});
$('z-in').addEventListener('click',()=>setZoom(state.zoom+.25));$('z-out').addEventListener('click',()=>setZoom(state.zoom-.25));$('z-fit').addEventListener('click',()=>setZoom(1));
$('d-close').addEventListener('click',requestClose);$('d-cancel').addEventListener('click',requestClose);$('d-save').addEventListener('click',save);$('d-next').addEventListener('click',()=>{const nx=nextReview();if(nx)openReview(nx.documentId,null);});
$('ask-no').addEventListener('click',()=>answer(false));$('ask-yes').addEventListener('click',()=>answer(true));
dlg.addEventListener('keydown',e=>{if(e.key==='Escape'){e.preventDefault();e.stopPropagation();if(state.askResolve)answer(false);else requestClose();return;}if((e.metaKey||e.ctrlKey)&&(e.key==='s'||e.key==='S')){e.preventDefault();if(!state.askResolve)save();}});
dlg.addEventListener('cancel',e=>{e.preventDefault();if(!state.askResolve)requestClose();});
dlg.addEventListener('close',()=>{if(!state.current)return;if(state.dirty){dlg.showModal();requestClose();return;}finishClose();});
document.addEventListener('keydown',e=>{if(e.key==='/'&&!busyUi()&&!(e.target instanceof HTMLInputElement||e.target instanceof HTMLSelectElement||e.target instanceof HTMLTextAreaElement)){e.preventDefault();$('q').focus();}});
document.addEventListener('visibilitychange',()=>{if(document.hidden){clearTimeout(state.timer);state.timer=0;}else tick();});
window.addEventListener('beforeunload',e=>{if(state.leaving)return;if(state.dirty||state.active>0||state.uploads.some(u=>u.status==='waiting'||u.status==='authwait')){e.preventDefault();e.returnValue='';}});
window.addEventListener('resize',()=>{if(state.user)showMenu(true);});
/* Login. method=post on the form means a script failure can never put a password in a URL or in an nginx log. */
$('login-form').addEventListener('submit',e=>{e.preventDefault();submitLogin();});
$('login-submit').addEventListener('click',e=>{e.preventDefault();submitLogin();});
/* Usernames are ASCII by a database CHECK and the login answer carries no format error, so a Thai keyboard layout
   would otherwise burn throttle attempts on a generic INVALID_CREDENTIALS with no clue why. */
$('login-user').addEventListener('input',()=>{$('login-hint').hidden=!/[^\x00-\x7F]/.test(String($('login-user').value||''));});
$('login-reveal').addEventListener('click',()=>{const i=$('login-pass'),show=i.type==='password';i.type=show?'text':'password';const b=$('login-reveal');b.textContent=show?'ซ่อนรหัสผ่าน':'แสดงรหัสผ่าน';b.setAttribute('aria-pressed',show?'true':'false');i.focus();});
$('auth-dlg').addEventListener('cancel',e=>{e.preventDefault();});
$('pw-open').addEventListener('click',()=>openPassword(false));$('me-pw').addEventListener('click',()=>{closeMe();openPassword(false);});
$('pw-form').addEventListener('submit',e=>{e.preventDefault();submitPassword();});
$('pw-save').addEventListener('click',e=>{e.preventDefault();submitPassword();});
$('pw-cancel').addEventListener('click',closePassword);
$('pw-logout').addEventListener('click',()=>{logout();});
$('pw-dlg').addEventListener('cancel',e=>{e.preventDefault();closePassword();});
$('users-open').addEventListener('click',openUsers);$('me-users').addEventListener('click',openUsers);
$('users-close').addEventListener('click',closeUsers);
$('users-dlg').addEventListener('cancel',e=>{e.preventDefault();closeUsers();});
$('users-dlg').addEventListener('close',clearTemp);
$('user-form').addEventListener('submit',e=>{e.preventDefault();addUser();});
$('nu-add').addEventListener('click',e=>{e.preventDefault();addUser();});
$('temp-copy').addEventListener('click',copyTemp);
$('cf-no').addEventListener('click',()=>answerConfirm(false));$('cf-yes').addEventListener('click',()=>answerConfirm(true));
$('confirm-dlg').addEventListener('cancel',e=>{e.preventDefault();answerConfirm(false);});
$('me-open').addEventListener('click',()=>{const d=$('me-dlg');if(!d.open)d.showModal();});
$('me-close').addEventListener('click',closeMe);$('me-dlg').addEventListener('cancel',e=>{e.preventDefault();closeMe();});
$('logout').addEventListener('click',()=>{logout();});$('me-logout').addEventListener('click',()=>{closeMe();logout();});}

async function init(){wire();document.body.dataset.auth='checking';setConnection('wait');
let user=null;try{user=await checkSession();}catch(e){setConnection('error',e.message);}
if(!user){document.body.dataset.auth='out';try{await requireLogin();}catch(e){return;}}
else{document.body.dataset.auth='in';applyUser();setConnection('ok');}
if(state.user&&state.user.mustChangePassword)await forcedPasswordChange();
state.started=true;
await Promise.all([loadDocuments(),loadBatches()]);const deep=new URLSearchParams(location.search).get('document');if(deep){if(UUID.test(deep))openReview(deep.toLowerCase(),null);else{notify('ลิงก์เอกสารไม่ถูกต้อง','error');setUrl(null);}}schedule();}
init();
})();
`;

/** Renders the workbench. `nonce` must match the `script-src 'nonce-…'` of the response's CSP. */
export function workbenchPage(options: { nonce: string }): string {
  const nonce = escapeHtml(options.nonce);
  return `<!doctype html>
<html lang="th"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"><link rel="icon" href="data:,"><title>เอกสาร OCR · INNOVERA</title>
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin><link rel="stylesheet" href="${FONTS}">
<style>${STYLE}</style></head><body data-auth="checking">
${BODY}
<script nonce="${nonce}">${SCRIPT}</script>
</body></html>`;
}
