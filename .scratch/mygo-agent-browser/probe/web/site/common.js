window.__events = window.__events || [];
try {
  mygo.on("probe:mark", function (e) { window.__events.push(e); window.__lastMark = e; });
} catch (e) {}
window.__secret = function () {
  return mygo.call("Probe.Secret").then(
    function (v) { return { ok: true, v: v }; },
    function (e) { return { ok: false, e: String((e && e.message) || e) }; }
  );
};
