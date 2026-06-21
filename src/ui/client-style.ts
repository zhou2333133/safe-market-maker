export const appCssText = String.raw`:root {
  color-scheme: light;
  --bg: #f7f8f7;
  --surface: #ffffff;
  --surface-alt: #f1f4f2;
  --surface-soft: #fbfcfb;
  --ink: #14201b;
  --muted: #68736d;
  --line: #dfe6e2;
  --teal: #087f73;
  --teal-dark: #05665d;
  --green: #23834b;
  --red: #b83c38;
  --amber: #a96406;
  --blue: #315f9f;
  --shadow: 0 14px 34px rgb(22 33 28 / 0.07);
  --shadow-soft: 0 8px 22px rgb(22 33 28 / 0.045);
  font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
}

* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--ink); overflow-x: hidden; }
button, input, select { font: inherit; }
button { cursor: pointer; }
button:disabled { cursor: not-allowed; opacity: 0.55; }

.shell { min-height: 100vh; width: 100vw; display: grid; grid-template-columns: 148px minmax(0, 1fr); }
.sidebar { position: sticky; top: 0; height: 100vh; padding: 12px 10px; border-right: 1px solid var(--line); background: #ffffff; display: flex; flex-direction: column; gap: 14px; box-shadow: 6px 0 24px rgb(22 33 28 / 0.025); }
.brand { display: grid; gap: 9px; align-items: start; }
.brand-mark { width: 38px; height: 38px; border-radius: 8px; background: linear-gradient(180deg, #0a8d7f, #06695f); color: white; display: grid; place-items: center; font-weight: 800; box-shadow: 0 10px 20px rgb(8 127 115 / 0.18); }
.brand h1 { font-size: 14px; line-height: 1.2; margin: 0; }
.brand p { margin: 4px 0 0; color: var(--muted); font-size: 13px; }
.nav { display: grid; gap: 8px; }
.nav-item { text-align: left; border: 1px solid transparent; background: transparent; color: var(--muted); border-radius: 8px; padding: 10px 11px; }
.nav-item.active, .nav-item:hover { background: #edf6f3; color: var(--ink); border-color: #cfe4dd; }
.guardrail { margin-top: auto; padding: 12px; border: 1px solid #cfe4dd; color: var(--teal-dark); background: #f1faf7; border-radius: 8px; display: flex; gap: 8px; align-items: center; font-size: 13px; }
.dot { width: 8px; height: 8px; border-radius: 99px; background: var(--teal); }

.main { min-width: 0; width: 100%; max-width: none; margin: 0; padding: 10px 14px 16px; }
.topbar { display: flex; align-items: center; justify-content: space-between; gap: 16px; margin-bottom: 12px; }
.eyebrow { color: var(--teal-dark); font-size: 12px; font-weight: 700; margin: 0 0 6px; text-transform: uppercase; letter-spacing: 0; }
h2 { margin: 0; font-size: 26px; }
h3 { margin: 0; font-size: 16px; }
h4 { margin: 0 0 10px; color: var(--muted); font-size: 13px; }
.view { display: none; }
.view.active { display: block; }
#view-dashboard.active { display: flex; flex-direction: column; }
.hidden { display: none !important; }

.metric-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(170px, 1fr)); gap: 12px; margin-bottom: 14px; }
.metric, .panel { background: var(--surface); border: 1px solid var(--line); border-radius: 8px; box-shadow: var(--shadow-soft); }
.metric { padding: 13px; min-height: 86px; }
.metric span { color: var(--muted); font-size: 13px; }
.metric strong { display: block; margin-top: 8px; font-size: 18px; line-height: 1.14; overflow-wrap: anywhere; }
.live-on { color: var(--teal-dark); }
.danger-text { color: var(--red); }
.good-text { color: var(--green); }

.store-status-panel { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 12px; margin-bottom: 14px; }
.store-status-item { border: 1px solid var(--line); border-radius: 8px; padding: 12px 14px; background: var(--surface); min-width: 0; }
.store-status-item span { color: var(--muted); font-size: 12px; font-weight: 700; }
.store-status-item strong { display: block; margin-top: 7px; font-size: 18px; line-height: 1.18; overflow-wrap: anywhere; }
.store-status-item p { margin: 7px 0 0; color: var(--muted); font-size: 12px; line-height: 1.35; overflow-wrap: anywhere; }

.content-grid { display: grid; grid-template-columns: minmax(0, 1.2fr) minmax(320px, 0.8fr); gap: 14px; }
.panel { padding: 16px; min-width: 0; }
.panel-head { display: flex; align-items: center; justify-content: space-between; gap: 10px; margin-bottom: 14px; }
.panel-head p { margin: 5px 0 0; color: var(--muted); font-size: 13px; }
.tag { font-size: 12px; color: var(--muted); background: var(--surface-alt); border: 1px solid var(--line); padding: 4px 8px; border-radius: 999px; white-space: nowrap; }
.tag.danger { color: var(--red); background: #fff0ef; border-color: #f2cfca; }
.cockpit-settings h3 { font-size: 17px; }
.cockpit-settings { margin-bottom: 10px; border-color: #cfe4dd; background: #fbfffd; }
.strategy-console { order: 1; display: grid; grid-template-columns: minmax(240px, 0.55fr) minmax(0, 1.45fr); gap: 10px; align-items: stretch; padding: 10px; border-left: 4px solid var(--teal); box-shadow: var(--shadow-soft); }
.strategy-console-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; min-width: 0; }
.strategy-console-head > div { min-width: 0; }
.strategy-console-head p:not(.eyebrow) { margin: 6px 0 0; color: var(--muted); font-size: 12px; line-height: 1.35; overflow-wrap: anywhere; }
.strategy-console-head .primary-btn { flex: 0 0 auto; min-height: 40px; }
.core-setting-grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 7px; min-width: 0; }
.pl-status-grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 8px; margin: 12px 0; }
.pl-status-grid > div { border: 1px solid var(--line); border-radius: 8px; padding: 10px 12px; background: var(--surface); min-width: 0; display: flex; flex-direction: column; gap: 5px; }
.pl-status-grid span { color: var(--muted); font-size: 11px; font-weight: 700; }
.pl-status-grid strong { font-size: 14px; overflow-wrap: anywhere; }
.core-field { border: 1px solid #d8e6e1; border-radius: 8px; background: #fff; padding: 8px; min-width: 0; }
.core-field span { color: var(--teal-dark); font-size: 12px; font-weight: 800; }
.core-field input { min-height: 38px; padding: 8px 9px; font-size: 16px; font-weight: 800; }
.strategy-readouts { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; min-width: 0; }
.strategy-readouts div { border: 1px solid var(--line); border-radius: 8px; background: #fbfcfb; padding: 8px 9px; min-width: 0; }
.strategy-readouts span { color: var(--muted); font-size: 11px; font-weight: 800; }
.strategy-readouts strong { display: block; margin-top: 4px; font-size: 13px; line-height: 1.2; overflow-wrap: anywhere; }
.live-command-bar { order: 0; position: sticky; top: 0; z-index: 5; display: grid; grid-template-columns: minmax(320px, 0.75fr) minmax(520px, 1.25fr) auto; gap: 8px 10px; align-items: center; margin-bottom: 10px; padding: 10px; border: 1px solid #cfe4dd; border-left: 4px solid var(--teal); border-radius: 8px; background: rgba(255, 255, 255, 0.98); box-shadow: var(--shadow); backdrop-filter: blur(8px); }
.command-status { display: flex; align-items: center; gap: 10px; min-width: 0; }
.command-status div { min-width: 0; }
.command-status strong { display: block; font-size: 18px; line-height: 1.15; overflow-wrap: anywhere; }
.command-status p { margin: 4px 0 0; color: var(--muted); font-size: 12px; line-height: 1.3; overflow-wrap: anywhere; word-break: break-word; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.command-kpis { grid-column: 2; grid-row: 1 / span 2; display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); gap: 6px; }
.command-kpis div { min-width: 0; border: 1px solid var(--line); border-radius: 8px; background: #fbfcfb; padding: 6px 8px; }
.command-kpis span { color: var(--muted); font-size: 11px; font-weight: 700; }
.command-kpis strong { display: block; margin-top: 3px; font-size: 13px; line-height: 1.15; overflow-wrap: anywhere; }
.command-actions { grid-column: 3; grid-row: 1; display: flex; align-items: center; justify-content: flex-end; gap: 6px; flex-wrap: nowrap; min-width: 0; }
.command-actions button { min-width: 86px; min-height: 38px; padding: 0 12px; white-space: nowrap; font-size: 13px; }
.command-actions #stopCancelBtn { min-width: 112px; }
.command-actions button.is-busy { position: relative; box-shadow: inset 0 0 0 999px rgb(255 255 255 / 0.12); }
.command-context { grid-column: 3; grid-row: 2; display: grid; grid-template-columns: 110px minmax(180px, 260px); gap: 6px; align-items: stretch; min-width: 0; }
.venue-picker { gap: 5px; }
.venue-picker span { color: var(--muted); font-size: 11px; font-weight: 800; }
.venue-picker select { min-height: 38px; padding: 7px 9px; }
.compact-runtime { min-height: 38px; padding: 7px 9px; gap: 1px; }
.compact-runtime strong { font-size: 13px; }
.compact-runtime small { display: none; }
.compact-live-detail { min-height: 38px; max-height: 48px; display: flex; align-items: center; padding: 7px 9px; overflow: hidden; overflow-wrap: anywhere; word-break: break-word; }
.overview-layout { display: grid; grid-template-columns: minmax(0, 1fr) minmax(320px, 0.24fr); gap: 10px; margin-bottom: 10px; align-items: start; }
.overview-layout { order: 2; }
.overview-main, .overview-side { min-width: 0; }
.overview-side { display: grid; gap: 10px; }
.compact-metrics { grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; margin-bottom: 0; }
.compact-metrics .metric { min-height: 68px; padding: 10px; }
.compact-metrics .metric strong { font-size: 16px; margin-top: 6px; }
.live-grid { display: grid; grid-template-columns: minmax(170px, 0.55fr) minmax(280px, 0.85fr) minmax(300px, 1.2fr); gap: 10px; align-items: end; }
.live-actions { display: flex; gap: 8px; flex-wrap: wrap; justify-content: flex-end; }
.live-actions button { min-width: 104px; }
.live-detail { min-height: 42px; max-height: 78px; padding: 8px 10px; border: 1px solid var(--line); border-radius: 8px; color: var(--muted); background: var(--surface-alt); overflow: auto; overflow-wrap: anywhere; word-break: break-word; font-size: 12px; line-height: 1.35; }
.stage-strip { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px; }
.stage-strip div { border: 1px solid #d8e6e1; border-radius: 8px; background: #fbfcfb; padding: 8px 10px; min-width: 0; }
.stage-strip span { color: var(--teal-dark); font-size: 12px; font-weight: 700; }
.stage-strip strong { display: block; margin-top: 4px; font-size: 13px; line-height: 1.25; overflow-wrap: anywhere; }
.bot-activity { margin-top: 8px; display: grid; grid-template-columns: minmax(250px, 0.72fr) minmax(360px, 1.28fr); gap: 8px; border: 1px solid #d5e2dc; border-left: 4px solid #6ea59a; border-radius: 8px; background: #fff; padding: 10px; box-shadow: var(--shadow-soft); }
.bot-activity-main, .bot-activity-item { min-width: 0; }
.bot-activity-main span, .bot-activity-item span { color: var(--teal-dark); font-size: 12px; font-weight: 700; }
.bot-activity-main strong { display: block; margin-top: 5px; font-size: 17px; line-height: 1.18; overflow-wrap: anywhere; }
.bot-activity-main p { margin: 6px 0 0; color: var(--muted); font-size: 12px; line-height: 1.35; overflow-wrap: anywhere; word-break: break-word; }
.bot-activity-list { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 6px; max-height: 96px; overflow: auto; padding-right: 2px; margin-top: 6px; }
.bot-activity-item { border: 1px solid var(--line); border-radius: 8px; background: #fff; padding: 7px 9px; display: grid; grid-template-columns: 1fr auto; gap: 3px 8px; min-width: 0; }
.bot-activity-item strong { font-size: 13px; line-height: 1.3; overflow-wrap: anywhere; word-break: break-word; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.bot-activity-item time { color: var(--muted); font-size: 12px; grid-column: 2; grid-row: 1 / span 2; align-self: center; white-space: nowrap; }
.bot-activity-item.warn { border-color: #efd2a2; background: #fff8ec; }
.bot-activity-item.error { border-color: #f2cfca; background: #fff0ef; }
.bot-activity-item.local { border-style: dashed; }
.startup-card { border: 1px solid var(--line); border-left: 4px solid #8ba39a; border-radius: 8px; background: #fff; display: grid; grid-template-columns: 1fr; gap: 8px; padding: 10px; box-shadow: var(--shadow-soft); }
.startup-card.ready { background: #eef9f2; border-color: #b9dfc8; }
.startup-card.blocked { background: #fff8ec; border-color: #efd2a2; }
.startup-main span, .startup-grid span { color: var(--muted); font-size: 12px; font-weight: 700; }
.startup-main strong { display: block; margin-top: 6px; font-size: 16px; line-height: 1.2; overflow-wrap: anywhere; }
.startup-main p { margin: 8px 0 0; color: var(--muted); font-size: 13px; line-height: 1.4; overflow-wrap: anywhere; }
.startup-grid { display: grid; grid-template-columns: 1fr; gap: 7px; }
.startup-grid div { background: #fff; border: 1px solid var(--line); border-radius: 8px; padding: 9px; min-width: 0; }
.startup-grid strong { display: block; margin-top: 5px; font-size: 13px; line-height: 1.3; overflow-wrap: anywhere; }
.startup-grid .gas-address-row { border-color: #e0b75e; background: #fffaf0; }
.startup-grid .gas-address-row strong { font-family: ui-monospace, SFMono-Regular, Consolas, "Liberation Mono", monospace; font-size: 12px; user-select: all; }
.startup-details { border-top: 1px solid rgb(22 33 28 / 0.08); padding-top: 2px; }
.startup-details summary { cursor: pointer; color: var(--teal-dark); font-size: 12px; font-weight: 800; list-style: none; padding: 6px 0 0; }
.startup-details summary::-webkit-details-marker { display: none; }
.startup-details summary::after { content: "↓"; margin-left: 6px; }
.startup-details[open] summary { margin-bottom: 8px; }
.startup-details[open] summary::after { content: "↑"; }
.wide-stat { grid-column: 1 / -1; }
.current-order-card { margin-bottom: 8px; display: grid; grid-template-columns: minmax(0, 1fr) minmax(210px, 0.32fr); gap: 8px; border: 1px solid #9bcfc5; border-left: 4px solid var(--teal); border-radius: 8px; background: #fff; padding: 10px; box-shadow: var(--shadow-soft); }
.current-order-card div { min-width: 0; }
.current-order-card span { color: var(--teal-dark); font-size: 12px; font-weight: 800; }
.current-order-card strong { display: block; margin-top: 5px; font-size: 22px; line-height: 1.15; overflow-wrap: anywhere; }
.current-order-card p { margin: 6px 0 0; color: var(--muted); font-size: 12px; line-height: 1.35; overflow-wrap: anywhere; }
.target-order-box { border-left: 1px solid #cfe4dd; padding-left: 12px; }
.pair-leg-grid, .basket-grid { grid-column: 1 / -1; display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 7px; }
.basket-grid { max-height: min(48vh, 500px); overflow: auto; padding-right: 2px; }
.pair-leg { border: 1px solid var(--line); border-radius: 8px; background: #fff; padding: 8px; min-width: 0; }
.pair-leg span { color: var(--muted); font-size: 11px; font-weight: 900; text-transform: uppercase; letter-spacing: 0; }
.pair-leg strong { font-size: 14px; line-height: 1.18; }
.pair-leg p { margin-top: 5px; }
.pair-leg.open { border-color: #9bcfc5; background: #f2fbf8; }
.pair-leg.pending-open, .pair-leg.planned { border-color: #e4c27c; background: #fffaf0; }
.pair-leg.missing { border-color: #f0b5ad; background: #fff4f2; }
.pair-leg.empty { grid-column: 1 / -1; background: var(--surface-soft); }
.route-panel { margin-top: 0; border: 1px solid #e5cfaa; border-left: 4px solid #c88d2c; border-radius: 8px; background: #fff; display: grid; grid-template-columns: minmax(0, 0.85fr) minmax(360px, 1.15fr); gap: 8px; padding: 10px; box-shadow: var(--shadow-soft); }
.route-panel.empty-route { background: var(--surface-alt); border-color: var(--line); }
.route-panel.route-risk { background: #fff8ec; border-color: #efd2a2; }
.route-primary span, .route-stats span { color: var(--teal-dark); font-size: 12px; font-weight: 700; }
.route-primary strong { display: block; margin-top: 5px; font-size: 20px; line-height: 1.16; overflow-wrap: anywhere; }
.route-primary p { margin: 7px 0 0; color: var(--muted); font-size: 12px; line-height: 1.35; overflow-wrap: anywhere; }
.route-stats { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 7px; }
.route-stats div { background: #fbfcfb; border: 1px solid var(--line); border-radius: 8px; padding: 8px; min-width: 0; }
.route-stats strong { display: block; margin-top: 4px; font-size: 14px; line-height: 1.18; overflow-wrap: anywhere; }
.pp-estimate-panel { margin-top: 8px; border: 1px solid #b9dfc8; border-left: 4px solid var(--green); border-radius: 8px; background: #fff; display: grid; grid-template-columns: minmax(260px, 0.75fr) minmax(360px, 1.25fr); gap: 8px; padding: 10px; box-shadow: var(--shadow-soft); }
.pp-estimate-panel.waiting { background: var(--surface-alt); border-color: var(--line); }
.pp-estimate-main, .pp-estimate-stats div { min-width: 0; }
.pp-estimate-main span, .pp-estimate-stats span { color: var(--teal-dark); font-size: 12px; font-weight: 800; }
.pp-estimate-main strong { display: block; margin-top: 5px; color: var(--green); font-size: 22px; line-height: 1.15; overflow-wrap: anywhere; }
.pp-estimate-main p { margin: 7px 0 0; color: var(--muted); font-size: 12px; line-height: 1.35; overflow-wrap: anywhere; }
.pp-estimate-stats { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 7px; }
.pp-estimate-stats div { background: #fbfcfb; border: 1px solid var(--line); border-radius: 8px; padding: 8px; }
.pp-estimate-stats strong { display: block; margin-top: 4px; font-size: 14px; line-height: 1.18; overflow-wrap: anywhere; }
.proof-panel { margin-top: 8px; border: 1px solid #cdd9ec; border-left: 4px solid var(--blue); border-radius: 8px; background: #fff; padding: 10px; box-shadow: var(--shadow-soft); }
.proof-head { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 10px; align-items: center; }
.proof-head span, .proof-metrics span, .proof-row span { color: var(--muted); font-size: 11px; font-weight: 800; }
.proof-head strong { display: block; margin-top: 4px; font-size: 17px; line-height: 1.18; overflow-wrap: anywhere; }
.proof-head p { margin: 5px 0 0; color: var(--muted); font-size: 12px; line-height: 1.35; overflow-wrap: anywhere; }
.proof-head button { min-height: 36px; padding: 0 12px; }
.proof-metrics { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 7px; margin-top: 9px; }
.proof-metrics div { border: 1px solid var(--line); border-radius: 8px; background: #fbfcfb; padding: 8px; min-width: 0; }
.proof-metrics strong { display: block; margin-top: 4px; font-size: 13px; line-height: 1.2; overflow-wrap: anywhere; }
.proof-list { display: grid; grid-template-columns: repeat(auto-fit, minmax(320px, 1fr)); gap: 7px; margin-top: 8px; }
.proof-row { border: 1px solid var(--line); border-radius: 8px; background: #fff; padding: 8px; min-width: 0; }
.proof-row.ok { border-color: #b9dfc8; background: #f3fbf6; }
.proof-row.miss { border-color: #efd2a2; background: #fffaf0; }
.proof-row strong { display: block; margin-top: 4px; font-size: 13px; line-height: 1.25; overflow-wrap: anywhere; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.proof-row p { margin: 5px 0 0; color: var(--muted); font-size: 12px; line-height: 1.3; overflow-wrap: anywhere; }
.proof-note { grid-column: 1 / -1; border: 1px dashed #efd2a2; border-radius: 8px; background: #fffaf0; color: var(--amber); padding: 8px 10px; font-size: 12px; line-height: 1.35; }
.proof-note.ok { border-color: #b9dfc8; background: #f3fbf6; color: var(--teal-dark); }
.balance-list { margin-top: 10px; display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 8px; }
.compact-balance { margin-top: 0; grid-template-columns: 1fr; }
.balance-address { grid-column: 1 / -1; color: var(--muted); font-size: 12px; }
.balance-item { border: 1px solid var(--line); border-radius: 8px; padding: 10px; background: #fff; display: grid; gap: 4px; }
.balance-item span { color: var(--muted); font-size: 12px; }
.balance-item strong { font-size: 16px; }
.balance-item em { color: var(--muted); font-size: 12px; font-style: normal; }
.order-risk-card { border: 1px solid var(--line); border-left: 4px solid #8ba39a; border-radius: 8px; background: #fff; padding: 10px; box-shadow: var(--shadow-soft); display: grid; gap: 8px; }
.order-risk-card.active { border-color: #efd2a2; background: #fffaf0; }
.order-risk-card.blocked { border-color: #f2cfca; background: #fff0ef; }
.order-risk-main span, .order-risk-grid span { color: var(--muted); font-size: 11px; font-weight: 800; }
.order-risk-main strong { display: block; margin-top: 5px; font-size: 20px; line-height: 1.15; overflow-wrap: anywhere; }
.order-risk-main p { margin: 6px 0 0; color: var(--muted); font-size: 12px; line-height: 1.35; overflow-wrap: anywhere; }
.order-risk-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 7px; }
.order-risk-grid div { border: 1px solid var(--line); border-radius: 8px; background: #fff; padding: 8px; min-width: 0; }
.order-risk-grid strong { display: block; margin-top: 4px; font-size: 13px; line-height: 1.2; overflow-wrap: anywhere; }
.live-log-grid { margin-bottom: 14px; grid-template-columns: minmax(0, 1.2fr) minmax(280px, 0.8fr); align-items: start; opacity: 0.9; }
.live-log-grid { order: 4; }
.settings-panel { margin-bottom: 12px; padding: 0; overflow: hidden; }
.settings-panel { order: 3; }
.settings-panel-summary, .orders-details summary, .log-details summary { display: flex; align-items: center; justify-content: space-between; gap: 12px; cursor: pointer; padding: 14px 16px; list-style: none; }
.settings-panel-summary::-webkit-details-marker, .orders-details summary::-webkit-details-marker, .log-details summary::-webkit-details-marker { display: none; }
.settings-panel-summary span, .orders-details summary span, .log-details summary span { display: grid; gap: 4px; min-width: 0; }
.settings-panel-summary strong, .orders-details summary strong, .log-details summary strong { font-size: 16px; }
.settings-panel-summary small, .orders-details summary small, .log-details summary small { color: var(--muted); font-size: 12px; line-height: 1.35; }
.settings-panel-summary em, .orders-details summary em, .log-details summary em { color: var(--teal-dark); font-size: 12px; font-style: normal; font-weight: 800; white-space: nowrap; }
.settings-panel[open] .settings-panel-summary, .orders-details[open] summary, .log-details[open] summary { border-bottom: 1px solid var(--line); }
.settings-panel[open] .settings-panel-summary em, .orders-details[open] summary em, .log-details[open] summary em { color: var(--muted); font-size: 0; }
.settings-panel[open] .settings-panel-summary em::before, .orders-details[open] summary em::before, .log-details[open] summary em::before { content: "收起"; font-size: 12px; }
.settings-panel-body { padding: 14px 16px 16px; }
.settings-group { border: 1px solid var(--line); border-radius: 8px; background: #fff; padding: 12px; margin-top: 10px; }
.settings-group:first-of-type { margin-top: 0; }
.layer-core { border-color: #9bcfc5; background: #f2fbf8; }
.layer-route { border-color: #cdd9ec; background: #f8fbff; }
.settings-group-head { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; margin-bottom: 12px; }
.settings-group-head strong, .settings-group summary strong { color: var(--ink); font-size: 15px; }
.settings-group-head span, .settings-group summary span { color: var(--muted); font-size: 12px; line-height: 1.35; }
.settings-group summary { cursor: pointer; display: flex; align-items: baseline; justify-content: space-between; gap: 12px; list-style: none; }
.settings-group summary::-webkit-details-marker { display: none; }
.advanced-settings { background: #fbfcf9; border-style: dashed; }
.advanced-settings .settings-grid { margin-top: 12px; }
.runtime-key-status { border: 1px solid #cfe4dd; border-radius: 8px; background: #eef8f5; min-height: 42px; padding: 10px 12px; display: grid; gap: 4px; }
.runtime-key-status span { color: var(--teal-dark); font-size: 12px; font-weight: 700; }
.runtime-key-status strong { font-size: 15px; line-height: 1.25; overflow-wrap: anywhere; }
.runtime-key-status small { color: var(--muted); font-size: 12px; line-height: 1.35; }
.account-summary-card { border: 1px solid var(--line); border-radius: 8px; background: #fff; display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 0; overflow: hidden; box-shadow: var(--shadow-soft); }
.account-summary-card div { min-width: 0; padding: 10px; border-right: 1px solid var(--line); border-bottom: 1px solid var(--line); }
.account-summary-card div:nth-child(2n) { border-right: 0; }
.account-summary-card div:nth-last-child(-n + 2) { border-bottom: 0; }
.account-summary-card span { color: var(--muted); font-size: 11px; font-weight: 800; }
.account-summary-card strong { display: block; margin-top: 5px; font-size: 14px; line-height: 1.2; overflow-wrap: anywhere; }
.account-summary-card small { display: block; margin-top: 4px; color: var(--muted); font-size: 11px; line-height: 1.25; overflow-wrap: anywhere; }
.account-summary-card .signer-row { grid-column: 1 / -1; border-right: 0; border-bottom: 0; background: #eef8f5; }
.settings-grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 10px; align-items: end; }
.primary-settings { grid-template-columns: repeat(6, minmax(0, 1fr)); }
.primary-settings .live-enable-row { grid-column: span 3; }
.check-row { display: flex; align-items: center; gap: 8px; min-height: 42px; color: var(--ink); }
.check-row input { width: 18px; min-height: 18px; height: 18px; accent-color: var(--teal); }
.live-enable-row { grid-column: 1 / -1; align-items: start; border: 1px solid #efd2a2; background: #fff8ec; border-radius: 8px; padding: 12px; }
.live-enable-row small { display: block; flex: 1 1 100%; margin-left: 26px; color: var(--amber); }
.toolbar-check { padding-bottom: 2px; }
.status-badge { border: 1px solid var(--line); border-radius: 999px; padding: 5px 9px; font-size: 12px; font-weight: 800; background: var(--surface-alt); color: var(--muted); }
.status-badge.running { color: var(--teal-dark); background: #eef8f5; border-color: #cfe4dd; }
.status-badge.stopping { color: var(--amber); background: #fff8ec; border-color: #efd2a2; }
.status-badge.error { color: var(--red); background: #fff0ef; border-color: #f2cfca; }
.risk-status-panel { margin-bottom: 14px; }
.risk-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 10px; }
.risk-item { border: 1px solid var(--line); border-radius: 8px; padding: 12px; background: #fff; min-width: 0; }
.risk-item span { color: var(--muted); font-size: 12px; font-weight: 700; }
.risk-item strong { display: block; margin-top: 7px; font-size: 20px; line-height: 1.15; overflow-wrap: anywhere; }
.risk-item p { margin: 7px 0 0; color: var(--muted); font-size: 12px; line-height: 1.35; }
.risk-item.ok { border-color: #b9dfc8; background: #eef9f2; }
.risk-item.bad { border-color: #f2cfca; background: #fff0ef; }
.risk-warning { grid-column: 1 / -1; border: 1px solid #efd2a2; background: #fff8ec; color: var(--amber); border-radius: 8px; padding: 10px 12px; font-size: 13px; }

.table-wrap { overflow: auto; }
table { width: 100%; border-collapse: collapse; font-size: 14px; }
th { text-align: left; color: var(--muted); font-weight: 600; border-bottom: 1px solid var(--line); padding: 10px 8px; }
td { border-bottom: 1px solid var(--line); padding: 11px 8px; }
td strong { display: block; font-size: 13px; overflow-wrap: anywhere; }
td small { display: block; margin-top: 4px; color: var(--muted); font-size: 12px; line-height: 1.25; overflow-wrap: anywhere; }
.empty { color: var(--muted); padding: 18px; text-align: center; }
.pill { display: inline-flex; align-items: center; justify-content: center; min-width: 52px; border-radius: 999px; padding: 4px 8px; font-size: 12px; font-weight: 700; }
.pill.buy { background: #e9f6ee; color: var(--green); }
.pill.sell { background: #fff0ef; color: var(--red); }
.status-chip { display: inline-flex; min-width: 64px; justify-content: center; border: 1px solid var(--line); border-radius: 999px; padding: 4px 8px; background: var(--surface-alt); color: var(--muted); font-size: 12px; font-weight: 800; }
.status-chip.open { color: var(--teal-dark); background: #eef8f5; border-color: #cfe4dd; }
.status-chip.pending_open, .status-chip.pending-open { color: var(--amber); background: #fff8ec; border-color: #efd2a2; }
.status-chip.planned { color: var(--amber); background: #fff8ec; border-color: #efd2a2; }
.status-chip.filled { color: var(--green); background: #e9f6ee; border-color: #b9dfc8; }
.status-chip.canceled, .status-chip.rejected { color: var(--red); background: #fff0ef; border-color: #f2cfca; }
.event-list { display: grid; gap: 8px; }
.event { border: 1px solid var(--line); border-radius: 8px; padding: 10px; display: grid; grid-template-columns: 1fr auto; gap: 4px 8px; }
.event span { color: var(--muted); font-size: 12px; }
.event strong { font-size: 13px; overflow-wrap: anywhere; word-break: break-word; }
.event time { color: var(--muted); font-size: 12px; grid-column: 2; grid-row: 1 / span 2; align-self: center; }
.event.warn { border-color: #efd2a2; background: #fff8ec; }
.event.error { border-color: #f2cfca; background: #fff0ef; }
.event.local { border-style: dashed; }
.orders-details, .log-details { padding: 0; overflow: hidden; background: #fbfcfb; box-shadow: none; }
.orders-details .table-wrap, .log-details .event-list { padding: 12px; }

label { display: grid; gap: 6px; color: var(--muted); font-size: 13px; }
input, select { width: 100%; border: 1px solid var(--line); border-radius: 8px; padding: 10px 11px; color: var(--ink); background: white; min-height: 42px; }
label small { color: var(--muted); font-size: 12px; line-height: 1.35; }
input:focus, select:focus, button:focus-visible { outline: 2px solid rgb(8 127 115 / 0.32); outline-offset: 2px; }
.primary-btn, .secondary-btn, .danger-btn, .icon-btn { border-radius: 8px; min-height: 42px; border: 1px solid transparent; padding: 0 14px; font-weight: 700; }
.primary-btn { background: var(--teal); color: white; }
.primary-btn:hover { background: var(--teal-dark); }
.primary-btn:disabled { background: #b9d7d2; color: #f7fffd; border-color: #a7cbc5; }
.secondary-btn { background: white; color: var(--ink); border-color: var(--line); }
.secondary-btn:hover { background: var(--surface-alt); }
.secondary-btn:disabled { background: #eef2ef; color: var(--muted); border-color: var(--line); }
.danger-btn { background: var(--red); color: white; }
.danger-btn:hover { background: #97302d; }
.danger-btn:disabled { background: #e3b1ac; color: #fff8f7; border-color: #d59a94; }
.icon-btn { width: 42px; padding: 0; background: white; border-color: var(--line); color: var(--ink); box-shadow: var(--shadow-soft); }
.full { width: 100%; }
.toolbar { display: flex; align-items: end; gap: 10px; flex-wrap: wrap; background: var(--surface); border: 1px solid var(--line); border-radius: 8px; padding: 14px; margin-bottom: 14px; }
.module-strip { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; margin-bottom: 14px; }
.module-strip article { background: var(--surface); border: 1px solid var(--line); border-radius: 8px; padding: 12px; display: grid; gap: 5px; }
.module-strip strong { font-size: 14px; }
.module-strip span { color: var(--muted); font-size: 13px; line-height: 1.4; }

.market-list { display: grid; gap: 10px; }
.market-row { background: var(--surface); border: 1px solid var(--line); border-radius: 8px; padding: 14px; display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 16px; align-items: center; }
.market-row h3 { margin-bottom: 6px; line-height: 1.35; }
.market-row p { margin: 0; color: var(--muted); font-size: 13px; overflow-wrap: anywhere; }
.market-meta { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; justify-content: flex-end; }
.market-meta span { background: var(--surface-alt); border: 1px solid var(--line); border-radius: 999px; color: var(--muted); padding: 5px 8px; font-size: 12px; }

.trade-layout { display: grid; grid-template-columns: minmax(360px, 440px) minmax(0, 1fr); gap: 14px; align-items: start; }
.trade-ticket { position: sticky; top: 18px; }
.segmented { display: grid; grid-template-columns: 1fr 1fr; background: var(--surface-alt); border: 1px solid var(--line); padding: 4px; border-radius: 8px; margin-bottom: 14px; }
.segment { min-height: 40px; border: 0; border-radius: 6px; background: transparent; color: var(--muted); font-weight: 800; }
.segment.active.buy { background: #e9f6ee; color: var(--green); }
.segment.active.sell { background: #fff0ef; color: var(--red); }
.form-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
.wide { grid-column: 1 / -1; }
.summary-strip { margin: 14px 0; padding: 12px; border-radius: 8px; background: var(--surface-alt); display: flex; align-items: center; justify-content: space-between; }
.summary-strip span { color: var(--muted); }
.summary-strip strong { font-size: 20px; }
.book { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin-bottom: 14px; }
.levels { display: grid; gap: 6px; }
.level { border: 1px solid var(--line); border-radius: 8px; background: white; min-height: 34px; padding: 6px 8px; display: flex; justify-content: space-between; align-items: center; }
.level.bid span { color: var(--green); }
.level.ask span { color: var(--red); }
.level:hover { background: var(--surface-alt); }
.alert { margin-bottom: 14px; border-radius: 8px; padding: 12px 14px; border: 1px solid var(--line); background: white; }
.alert.success { border-color: #b9dfc8; background: #eef9f2; color: #145c32; }
.alert.error { border-color: #f2cfca; background: #fff0ef; color: var(--red); }
.alert.info { border-color: #cfe4dd; background: #eef8f5; color: var(--teal-dark); }
.explain-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; }
.explain-card { border: 1px solid var(--line); border-radius: 8px; padding: 12px; min-width: 0; background: #fff; }
.card-top { display: flex; justify-content: space-between; gap: 8px; color: var(--muted); font-size: 13px; margin-bottom: 8px; }
.unit { border: 1px solid var(--line); border-radius: 999px; padding: 2px 7px; background: var(--surface-alt); font-size: 12px; }
.explain-card strong { display: block; font-size: 20px; line-height: 1.15; overflow-wrap: anywhere; }
.explain-card p { margin: 8px 0 0; color: var(--muted); font-size: 13px; line-height: 1.45; }

@media (max-width: 1180px) {
  .metric-grid { grid-template-columns: repeat(3, minmax(0, 1fr)); }
  .compact-metrics { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .store-status-panel { grid-template-columns: repeat(3, minmax(0, 1fr)); }
  .live-grid, .settings-grid { grid-template-columns: 1fr 1fr; }
  .strategy-console { grid-template-columns: 1fr; }
  .core-setting-grid, .pl-status-grid, .strategy-readouts, .pair-leg-grid, .basket-grid, .bot-activity-list, .proof-list { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .live-command-bar { grid-template-columns: 1fr; }
  .command-kpis, .command-actions, .command-context { grid-column: 1; grid-row: auto; }
  .command-actions { justify-content: flex-start; flex-wrap: wrap; }
  .command-context { grid-template-columns: 1fr 1fr; }
  .compact-live-detail { grid-column: 1 / -1; }
  .primary-settings { grid-template-columns: repeat(3, minmax(0, 1fr)); }
  .live-actions { justify-content: flex-start; }
}

@media (min-width: 1800px) {
  .shell { grid-template-columns: 156px minmax(0, 1fr); }
  .main { padding: 12px 18px 18px; }
  .overview-layout { grid-template-columns: minmax(0, 1fr) minmax(360px, 0.22fr); }
  .route-panel { grid-template-columns: minmax(420px, 0.72fr) minmax(620px, 1.28fr); }
  .current-order-card { grid-template-columns: minmax(0, 1fr) minmax(240px, 0.28fr); }
  .proof-metrics { grid-template-columns: repeat(4, minmax(160px, 1fr)); }
  .live-log-grid { grid-template-columns: minmax(0, 1fr) minmax(420px, 0.34fr); }
}

@media (max-width: 980px) {
  .shell { grid-template-columns: 1fr; }
  .sidebar { position: static; height: auto; border-right: 0; border-bottom: 1px solid var(--line); }
  .brand { display: flex; align-items: center; }
  .nav { grid-template-columns: repeat(3, 1fr); }
  .content-grid, .trade-layout, .overview-layout { grid-template-columns: 1fr; }
  .overview-side { position: static; }
  .route-panel, .pp-estimate-panel, .startup-card, .stage-strip, .bot-activity, .current-order-card { grid-template-columns: 1fr; }
  .target-order-box { border-left: 0; border-top: 1px solid #cfe4dd; padding-left: 0; padding-top: 10px; }
  .store-status-panel { grid-template-columns: 1fr; }
  .risk-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .trade-ticket { position: static; }
}

@media (max-width: 620px) {
  .main { padding: 14px; }
  .topbar, .market-row { grid-template-columns: 1fr; display: grid; align-items: start; }
  .nav { grid-template-columns: 1fr 1fr; }
  .metric-grid, .compact-metrics, .form-grid, .book, .explain-grid, .live-grid, .settings-grid, .primary-settings, .startup-grid, .route-stats, .pp-estimate-stats, .store-status-panel, .command-kpis, .command-context, .account-summary-card, .core-setting-grid, .pl-status-grid, .strategy-readouts, .pair-leg-grid, .basket-grid, .bot-activity-list, .proof-metrics, .proof-list, .proof-head { grid-template-columns: 1fr; }
  .strategy-console-head { align-items: stretch; display: grid; }
  .account-summary-card div { border-right: 0; }
  .account-summary-card div:nth-last-child(-n + 2) { border-bottom: 1px solid var(--line); }
  .account-summary-card div:last-child { border-bottom: 0; }
  .risk-grid { grid-template-columns: 1fr; }
  .module-strip { grid-template-columns: 1fr; }
  .live-actions, .command-actions { display: grid; }
}

/* === 实盘操作仓 trade board === */
.trade-board { background: var(--surface); border: 1px solid var(--line); border-top: 3px solid var(--teal); border-radius: 16px; padding: 18px 20px; margin-bottom: 16px; box-shadow: var(--shadow-soft); }
.tb-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 14px; }
.tb-eyebrow { display: block; color: var(--teal); font-size: 11px; font-weight: 900; letter-spacing: 1px; text-transform: uppercase; }
.tb-head strong { font-size: 18px; color: var(--ink); }
.tb-badge { font-size: 12px; font-weight: 800; padding: 5px 13px; border-radius: 999px; background: var(--surface-alt); color: var(--muted); border: 1px solid var(--line); white-space: nowrap; }
.tb-badge.running { background: rgb(35 131 75 / 0.12); color: var(--green); border-color: transparent; }
.tb-badge.error { background: rgb(184 60 56 / 0.12); color: var(--red); border-color: transparent; }
.tb-badge.stopping, .tb-badge.starting { background: rgb(169 100 6 / 0.12); color: var(--amber); border-color: transparent; }
.tb-market { padding: 12px 14px; background: var(--surface-soft); border: 1px solid var(--line); border-radius: 12px; margin-bottom: 12px; }
.tb-market > span { color: var(--muted); font-size: 11px; font-weight: 800; text-transform: uppercase; letter-spacing: .5px; }
.tb-market > strong { display: block; margin: 4px 0 3px; font-size: 16px; color: var(--ink); line-height: 1.32; overflow-wrap: anywhere; }
.tb-market > p { margin: 0; color: var(--teal-dark); font-size: 13px; font-weight: 800; }
.tb-tiles { display: grid; grid-template-columns: repeat(4, 1fr); gap: 10px; margin-bottom: 13px; }
.tb-tile { padding: 12px 13px; background: var(--surface-alt); border: 1px solid var(--line); border-radius: 12px; }
.tb-tile > span { display: block; color: var(--muted); font-size: 11px; font-weight: 800; }
.tb-tile > strong { display: block; margin: 5px 0 3px; font-size: 21px; font-weight: 900; color: var(--ink); letter-spacing: -.3px; }
.tb-tile > em { font-style: normal; font-size: 11px; color: var(--muted); font-weight: 700; line-height: 1.3; display: block; }
.tb-tile.good > strong, .tb-tile.good > em { color: var(--green); }
.tb-tile.warn > strong, .tb-tile.warn > em { color: var(--amber); }
.tb-tile.bad > strong, .tb-tile.bad > em { color: var(--red); }
.tb-foot { display: grid; gap: 7px; }
.tb-foot-row { display: flex; align-items: flex-start; gap: 8px; font-size: 12.5px; color: var(--muted); line-height: 1.42; }
.tb-foot-row strong { color: var(--ink); font-weight: 600; overflow-wrap: anywhere; }
.tb-ico { flex-shrink: 0; }
@media (max-width: 720px) { .tb-tiles { grid-template-columns: repeat(2, 1fr); } }
`;
