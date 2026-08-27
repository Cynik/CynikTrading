/* =========================================================================
   logic-test.js — run with:   node test/logic-test.js
   =========================================================================
   There's no test framework here on purpose. This file loads the real content
   script files into a fake browser (a stub `chrome.storage`, a stub `window`)
   and checks the logic that would be miserable to verify by clicking around:
   URL parsing, league resolution, the filtered-folder reorder, storage CRUD
   for every tab, and Better Trading import/export compatibility.

   It cannot test anything that needs a real page — the panel rendering, the
   selectors, drag and drop. Those still need you and DevTools.

   Run it after any change to store.js, location.js or exchange.js.
   ========================================================================= */

/* Load the real content-script files in a fake browser and exercise the
   logic: storage round-trips, league resolution, reorder, import/export. */
const fs = require("fs");
const path = require("path");
const vm = require("vm");

let store = {};
const chrome = {
  storage: {
    local: {
      get: async (keys) => {
        const k = typeof keys === "string" ? [keys] : Array.isArray(keys) ? keys : Object.keys(keys);
        const out = {};
        for (const key of k) if (key in store) out[key] = JSON.parse(JSON.stringify(store[key]));
        return out;
      },
      set: async (obj) => { Object.assign(store, JSON.parse(JSON.stringify(obj))); },
      remove: async (key) => { delete store[key]; },
    },
    onChanged: { addListener: () => {} },
  },
};

const sandbox = {
  chrome, console,
  structuredClone: (o) => JSON.parse(JSON.stringify(o)),
  TextEncoder, TextDecoder, Buffer,
  btoa: (s) => Buffer.from(s, "latin1").toString("base64"),
  atob: (s) => Buffer.from(s, "base64").toString("latin1"),
  Math, Date, JSON, Map, Set, Promise, Array, Object, String, Number, URL, Error,
};
sandbox.globalThis = sandbox;
sandbox.window = sandbox;   // in a real content script window IS the global
vm.createContext(sandbox);

for (const f of ["store.js", "location.js", "exchange.js"]) {
  vm.runInContext(fs.readFileSync(path.join(__dirname, "..", "src", "content", f), "utf8"), sandbox, { filename: f });
}
const PH = sandbox.PH;

let pass = 0, fail = 0;
const check = (name, cond, extra="") => {
  if (cond) { pass++; console.log("  ok   " + name); }
  else { fail++; console.log("  FAIL " + name + (extra ? "  -> " + extra : "")); }
};

(async () => {
console.log("\n== location parsing ==");
const p1 = PH.location.parsePath("/trade/search/Allflame/aBc123");
check("PoE1 pc", p1.version==="1" && p1.type==="search" && p1.league==="Allflame" && p1.slug==="aBc123", JSON.stringify(p1));

const p2 = PH.location.parsePath("/trade2/search/poe2/Runes%20of%20Aldur/xY9");
check("PoE2 realm segment", p2.version==="2" && p2.league==="poe2/Runes of Aldur" && p2.slug==="xY9", JSON.stringify(p2));

const p3 = PH.location.parsePath("/trade/search/xbox/Legion/qq1");
check("console realm", p3.league==="xbox/Legion" && p3.version==="1", JSON.stringify(p3));

const p4 = PH.location.parsePath("/trade");
check("bare /trade is incomplete", p4.type===null && p4.league===null, JSON.stringify(p4));

const p5 = PH.location.parsePath("/trade/search/Allflame/aBc123/live");
check("live flag", p5.isLive===true);

console.log("\n== url building ==");
const u = PH.location.buildUrl({version:"1",type:"search",slug:"aBc"}, "Curse of the Allflame");
check("parens/space encoding", u==="https://www.pathofexile.com/trade/search/Curse%20of%20the%20Allflame/aBc", u);
const u2 = PH.location.buildUrl({version:"2",type:"search",slug:"z9"}, "poe2/Standard");
check("realm slash preserved", u2==="https://www.pathofexile.com/trade2/search/poe2/Standard/z9", u2);
const u3 = PH.location.buildUrl({version:"1",type:"search",slug:"a"}, null);
check("no league -> null", u3===null);
const u4 = PH.location.buildUrl({version:"1",type:"search",slug:"a"}, "X", {live:true});
check("live suffix", u4.endsWith("/live"));

console.log("\n== league resolution (the survives-a-league-reset feature) ==");
const loc = {version:"1", type:"search", slug:"abc"};
check("uses current page league", PH.location.resolveLeague(loc, {pageLocation:{version:"1",league:"Allflame"}, lastSeenLeagues:{}})==="Allflame");
check("pinned league wins", PH.location.resolveLeague({...loc, league:"Standard"}, {pageLocation:{version:"1",league:"Allflame"}, lastSeenLeagues:{}})==="Standard");
check("falls back to last seen", PH.location.resolveLeague(loc, {pageLocation:{version:"1",league:null}, lastSeenLeagues:{"1":"Settlers"}})==="Settlers");
check("ignores other game's page league", PH.location.resolveLeague(loc, {pageLocation:{version:"2",league:"Runes"}, lastSeenLeagues:{"1":"Allflame"}})==="Allflame");
check("null when nothing known", PH.location.resolveLeague(loc, {pageLocation:{}, lastSeenLeagues:{}})===null);

console.log("\n== folders & trades ==");
const fA = await PH.store.saveFolder({title:"A", icon:"chaos", version:"1"});
const fB = await PH.store.saveFolder({title:"B", icon:"divine", version:"1"});
const fC = await PH.store.saveFolder({title:"C-poe2", icon:"poe2-divine", version:"2"});
check("three folders saved", (await PH.store.getFolders()).length===3);
check("ids assigned", Boolean(fA.id && fB.id && fC.id));

await PH.store.saveTrade(fA.id, {title:"t1", location:{version:"1",type:"search",slug:"s1"}});
await PH.store.saveTrade(fA.id, {title:"t2", location:{version:"1",type:"search",slug:"s2"}});
let trades = await PH.store.getTrades(fA.id);
check("two trades in A", trades.length===2);
check("completedAt defaulted", trades[0].completedAt===null);

await PH.store.reorderTrades(fA.id, [trades[1].id, trades[0].id]);
trades = await PH.store.getTrades(fA.id);
check("trade reorder persisted", trades[0].title==="t2" && trades[1].title==="t1");

console.log("\n== rolling price history ==");
const target = trades[0];
await PH.store.pushTradePrice(fA.id, target.id, {amount:10, currency:"chaos", capturedAt:"2026-01-01"});
await PH.store.pushTradePrice(fA.id, target.id, {amount:9, currency:"chaos", capturedAt:"2026-01-02"});
let priced = (await PH.store.getTrades(fA.id)).find(t=>t.id===target.id);
check("history accumulates", priced.priceHistory.length===2);
check("oldest first", priced.priceHistory[0].amount===10 && priced.priceHistory[1].amount===9);

await PH.store.pushTradePrice(fA.id, target.id, {amount:8, currency:"chaos", capturedAt:"2026-01-03"});
await PH.store.pushTradePrice(fA.id, target.id, {amount:7, currency:"chaos", capturedAt:"2026-01-04"});
await PH.store.pushTradePrice(fA.id, target.id, {amount:6, currency:"chaos", capturedAt:"2026-01-05"});
priced = (await PH.store.getTrades(fA.id)).find(t=>t.id===target.id);
check("history accumulates to 5", priced.priceHistory.length===5 && priced.priceHistory.map(p=>p.amount).join(",")==="10,9,8,7,6");

await PH.store.pushTradePrice(fA.id, target.id, {amount:5, currency:"chaos", capturedAt:"2026-01-06"});
priced = (await PH.store.getTrades(fA.id)).find(t=>t.id===target.id);
check("capped at 5, oldest dropped", priced.priceHistory.length===5 && priced.priceHistory.map(p=>p.amount).join(",")==="9,8,7,6,5");

await PH.store.pushTradePrice(fA.id, "not-a-real-id", {amount:1, currency:"chaos", capturedAt:"2026-01-07"});
check("unknown trade id is a no-op", (await PH.store.getTrades(fA.id)).length===2);

console.log("\n== price history dedup (same price, recent recheck) ==");
// history is currently [9,8,7,6,5] as of 2026-01-06. A same-price recheck an hour later
// should refresh the timestamp in place, not consume a slot.
await PH.store.pushTradePrice(fA.id, target.id, {amount:5, currency:"chaos", capturedAt:"2026-01-06T01:00:00Z"});
priced = (await PH.store.getTrades(fA.id)).find(t=>t.id===target.id);
check("same price within 3h collapses into the latest slot", priced.priceHistory.length===5 && priced.priceHistory.map(p=>p.amount).join(",")==="9,8,7,6,5");
check("timestamp refreshed on the collapsed entry", priced.priceHistory.at(-1).capturedAt==="2026-01-06T01:00:00Z");

// A same-price recheck outside the window earns its own slot even though the price didn't move.
await PH.store.pushTradePrice(fA.id, target.id, {amount:5, currency:"chaos", capturedAt:"2026-01-07T05:00:00Z"});
priced = (await PH.store.getTrades(fA.id)).find(t=>t.id===target.id);
check("same price but stale (>3h) still gets a new slot", priced.priceHistory.length===5 && priced.priceHistory.map(p=>p.amount).join(",")==="8,7,6,5,5");

// A genuine price change, even seconds later, always earns its own slot.
await PH.store.pushTradePrice(fA.id, target.id, {amount:4, currency:"chaos", capturedAt:"2026-01-07T05:00:05Z"});
priced = (await PH.store.getTrades(fA.id)).find(t=>t.id===target.id);
check("an actual price change is never collapsed", priced.priceHistory.length===5 && priced.priceHistory.map(p=>p.amount).join(",")==="7,6,5,5,4");

console.log("\n== the tricky one: reordering a filtered folder list ==");
// Only PoE1 folders are visible. Swapping them must not move the PoE2 folder.
await PH.store.reorderFolders([fB.id, fA.id]);
let folders = await PH.store.getFolders();
check("visible pair swapped", folders[0].id===fB.id && folders[1].id===fA.id, folders.map(f=>f.title).join(","));
check("hidden PoE2 folder stayed in slot 2", folders[2].id===fC.id, folders.map(f=>f.title).join(","));

await PH.store.reorderFolders([fA.id]);  // wrong length -> must be a no-op
folders = await PH.store.getFolders();
check("mismatched reorder is a no-op", folders[0].id===fB.id && folders.length===3);

console.log("\n== archive moves to end ==");
await PH.store.toggleFolderArchive(fB.id);
folders = await PH.store.getFolders();
check("archived folder now last", folders[folders.length-1].id===fB.id);
check("archivedAt is a timestamp", typeof folders[folders.length-1].archivedAt==="string");
await PH.store.toggleFolderArchive(fB.id);
check("restore clears archivedAt", (await PH.store.getFolders()).find(f=>f.id===fB.id).archivedAt===null);

console.log("\n== deleting a folder takes its trades ==");
await PH.store.deleteFolder(fA.id);
check("folder gone", !(await PH.store.getFolders()).some(f=>f.id===fA.id));
check("orphan trades cleaned up", (await PH.store.getTrades(fA.id)).length===0);

console.log("\n== live searches ==");
const l1 = await PH.store.saveLiveSearch({title:"watch1", location:{version:"1",type:"search",slug:"w1"}});
const l2 = await PH.store.saveLiveSearch({title:"watch2", location:{version:"1",type:"search",slug:"w2"}});
const l3 = await PH.store.saveLiveSearch({title:"watch-poe2", location:{version:"2",type:"search",slug:"w3"}});
check("three live searches saved", (await PH.store.getLiveSearches()).length===3);
check("ids assigned", Boolean(l1.id && l2.id && l3.id));
check("addedAt defaulted", typeof (await PH.store.getLiveSearches())[0].addedAt==="string");

await PH.store.saveLiveSearch({id:l1.id, title:"renamed"});
check("rename persisted", (await PH.store.getLiveSearches()).find(s=>s.id===l1.id).title==="renamed");

// Only PoE1 entries are visible in the UI. Swapping them must not move the PoE2 entry.
await PH.store.reorderLiveSearches([l2.id, l1.id]);
let liveSearches = await PH.store.getLiveSearches();
check("visible pair swapped", liveSearches[0].id===l2.id && liveSearches[1].id===l1.id, liveSearches.map(s=>s.title).join(","));
check("hidden PoE2 entry stayed in slot 2", liveSearches[2].id===l3.id, liveSearches.map(s=>s.title).join(","));

await PH.store.reorderLiveSearches(["not-a-real-id"]); // unknown id -> must be a no-op
liveSearches = await PH.store.getLiveSearches();
check("unknown-id reorder is a no-op", liveSearches[0].id===l2.id && liveSearches.length===3);

await PH.store.deleteLiveSearch(l2.id);
liveSearches = await PH.store.getLiveSearches();
check("delete removes just that one", liveSearches.length===2 && !liveSearches.some(s=>s.id===l2.id));

console.log("\n== last-seen leagues ==");
const mk = (slug, league="Allflame") => ({version:"1",type:"search",league,slug});
await PH.store.noteLeague(PH.location.parsePath("/trade")); // incomplete -> no-op, must not throw
check("lastSeenLeagues untouched by incomplete location", Object.keys(await PH.store.getLastSeenLeagues()).length===0);
await PH.store.noteLeague(mk("h1"));
check("lastSeenLeagues recorded", (await PH.store.getLastSeenLeagues())["1"]==="Allflame");
await PH.store.noteLeague(mk("h2", "Settlers"));
check("lastSeenLeagues updated on a new league", (await PH.store.getLastSeenLeagues())["1"]==="Settlers");

console.log("\n== saved listings ==");
check("starts empty", (await PH.store.getSavedListings()).length===0);
const s1 = await PH.store.saveSavedListing({
  title:"Windripper", price:"40 divine", seller:"someSeller", league:"Settlers",
  mods:["+47 to maximum Life", "23% increased Cast Speed"],
  location:{version:"1",type:"search",slug:"sl1"},
});
check("id and savedAt assigned", Boolean(s1.id) && typeof s1.savedAt==="string");
await PH.store.saveSavedListing({title:"Second one", location:{version:"1",type:"search",slug:"sl2"}});
let saved = await PH.store.getSavedListings();
check("two saved listings", saved.length===2);
check("newest first", saved[0].title==="Second one");

await PH.store.deleteSavedListing(s1.id);
saved = await PH.store.getSavedListings();
check("delete removes just that one", saved.length===1 && saved[0].title==="Second one");

console.log("\n== import / export ==");
const fixture="3:eyJpY24iOiJhc2NlbmRhbnQiLCJ0aXQiOiJ0ZXN0IFBvRSAyIGZvbGRlciDwn5eBIiwidmVyIjoiMiIsInRycyI6W3sidGl0IjoidGVzdCBQb0UgMiB0cmFkZSDwn5qaIiwibG9jIjoiMjpzZWFyY2g6Zm9vYmFyIn1dfQ==";
const parsed = PH.exchange.deserializeFolder(fixture);
check("BT v3 fixture parses", parsed && parsed.folder.icon==="ascendant" && parsed.folder.version==="2");
check("emoji title survives", parsed.folder.title.includes("🗁"), parsed && parsed.folder.title);
check("trade location unpacked", parsed.trades[0].location.slug==="foobar" && parsed.trades[0].location.version==="2");
check("re-export is byte-identical", PH.exchange.serializeFolder({...parsed.folder, id:"x"}, parsed.trades)===fixture);

const v1code = Buffer.from(JSON.stringify({icn:"chaos",tit:"legacy",trs:[{tit:"old",loc:"search:zz1"}]})).toString("base64");
const v1 = PH.exchange.deserializeFolder(v1code);
check("BT v1 (no prefix) parses", v1 && v1.folder.title==="legacy" && v1.trades[0].location.version==="1");
check("garbage returns null", PH.exchange.deserializeFolder("not a code")===null);
check("empty returns null", PH.exchange.deserializeFolder("   ")===null);

console.log("\n== backup round-trip ==");
store = {};  // fresh
const g1 = await PH.store.saveFolder({title:"Keep", icon:"exalt", version:"1"});
await PH.store.saveTrade(g1.id, {title:"kept search", location:{version:"1",type:"search",slug:"kk1"}});
const g2 = await PH.store.saveFolder({title:"Old", icon:"map", version:"1", archivedAt:new Date().toUTCString()});
const backup = await PH.exchange.generateBackupText();
check("backup has the hyphen fence", backup.includes("\n--------------------\n"));
check("two sections", backup.split("\n--------------------\n").length===2);

store = {};  // wipe and restore
const result = await PH.exchange.restoreFromText(backup);
check("restored both folders", result.restored===2, JSON.stringify(result));
const restored = await PH.store.getFolders();
check("active folder restored active", restored.find(f=>f.title==="Keep").archivedAt===null);
check("archived folder restored archived", typeof restored.find(f=>f.title==="Old").archivedAt==="string");
const rt = await PH.store.getTrades(restored.find(f=>f.title==="Keep").id);
check("trade came back", rt.length===1 && rt[0].location.slug==="kk1");
check("restore is additive, not destructive", (await PH.exchange.restoreFromText(backup)).restored===2 && (await PH.store.getFolders()).length===4);

console.log("\n== v0.1 migration ==");
store = { bookmarks: [
  {name:"old one", url:"https://www.pathofexile.com/trade/search/Allflame/oldslug"},
  {name:"bad", url:"not-a-url"},
]};
await PH.store.migrateLegacyBookmarks();
const migrated = await PH.store.getFolders();
check("created an Imported folder", migrated.length===1 && migrated[0].title==="Imported");
const mt = await PH.store.getTrades(migrated[0].id);
check("valid bookmark migrated", mt.length===1 && mt[0].location.slug==="oldslug", JSON.stringify(mt));
check("legacy key removed", !("bookmarks" in store));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
})();
