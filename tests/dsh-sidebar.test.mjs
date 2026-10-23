import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

test("Kami opens one session-owned right tab only for the selected Kami preset", async () => {
  const registrations = [], definitions = [], disposers = [], opens = [], focused = [], closed = [];
  const state = { mounted: "normal", expanded: true, tabs: [], byId: {
    normal: { projectionValues: { agentPreset: "standard" } },
    kami: { projectionValues: { agentPreset: "kami-translator" } },
    otherKami: { projectionValues: { agentPreset: "kami-translator" } }
  } };
  let plugin, cursor = 0, hooks = [], pending = [];
  const React = {
    createElement: (type, props) => ({ type, props }),
    useEffect(callback, dependencies) {
      const index = cursor++;
      if (!hooks[index] || dependencies.some((value, i) => value !== hooks[index][i])) pending.push(callback);
      hooks[index] = dependencies;
    }
  };
  vm.runInNewContext(await readFile(new URL("../dsh/client.js", import.meta.url), "utf8"), {
    window: { __ModuleLoader__: { load: (module) => { plugin = module.factory(() => React); } } }
  });
  const ctx = {
    effect(callback) { const dispose = callback(); if (dispose) disposers.push(dispose); },
    inject(_keys, callback) { return callback(this); },
    locale: { register() {}, bind: () => (key) => key },
    remote: { async $mount() { return () => {}; } },
    sessions: { list: { getSnapshot: () => ({ byId: state.byId }) } },
    sidebarRightTabs: { register(definition) { definitions.push(definition); return () => definitions.splice(definitions.indexOf(definition), 1); } },
    sidebarRight: {
      mounted: { getSnapshot: () => state.mounted }, openTabs: { getSnapshot: () => state.tabs },
      openTab(kind) { opens.push({ sessionId: state.mounted, kind }); state.tabs.push({ sessionId: state.mounted, tabId: `tab-${opens.length}`, kind }); },
      focus(id) { focused.push(id); }, isExpanded: () => state.expanded,
      toggleExpanded() { state.expanded = !state.expanded; },
      close(id) { closed.push(id); state.tabs = state.tabs.filter((tab) => tab.tabId !== id); }
    },
    slots: {
      inject(_name, callback) { return callback(); },
      register(options, component) { const row = { ...options, component }; registrations.push(row); const dispose = () => registrations.splice(registrations.indexOf(row), 1); disposers.push(dispose); return dispose; }
    }
  };
  await plugin.apply(ctx);
  assert.equal(definitions.length, 1, "register a right-sidebar tab type");
  assert.equal(registrations.some((entry) => ["main", "sidebar.panellist"].includes(entry.name)), false);
  const body = registrations.find((entry) => entry.name === "sidebar.right.pane.tab");
  assert.equal(body.key, definitions[0].id);
  const observer = registrations.find((entry) => entry.name === "shell.overlay");
  const props = { ...observer.inject(), useKamiMounted: (select) => select(state.mounted), useSessions: (select) => select({ byId: state.byId }) };
  const render = () => { cursor = 0; assert.equal(observer.component(props), null); for (const callback of pending.splice(0)) callback(); };
  render(); assert.equal(opens.length, 0);
  state.mounted = "kami"; render(); assert.equal(opens.length, 1);
  render(); assert.equal(opens.length, 1, "unrelated rerenders must not reopen the panel");
  state.mounted = "normal"; render(); assert.equal(closed.length, 0, "keep another session's Kami tab");
  state.mounted = "kami"; state.expanded = false; render();
  assert.equal(opens.length, 1, "reuse an existing tab across panes and session switches");
  assert.deepEqual(focused, ["tab-1"]); assert.equal(state.expanded, true);
  state.tabs.push({ sessionId: "kami", tabId: "file", kind: "file" }, { sessionId: "otherKami", tabId: "other", kind: definitions[0].kind });
  state.byId.kami.projectionValues.agentPreset = "standard"; render();
  assert.deepEqual(closed, ["tab-1"]);
  assert.deepEqual(state.tabs.map((tab) => tab.tabId), ["file", "other"]);
  const tabProps = { ...body.inject(), sessionId: "otherKami", useSessions: props.useSessions, useTabInfo: () => ({ tab: { visible: true } }) };
  const view = body.component(tabProps);
  assert.equal(view.props.sessionId, "otherKami", "bind the body to its own tab session, not the main-view session");
  assert.equal(body.component({ ...tabProps, sessionId: "normal" }), null);
  state.mounted = "normal"; props.openWorkbench("otherKami");
  assert.equal(opens.length, 1, "ignore callbacks captured before the user switched sessions");
  state.mounted = undefined; render(); assert.equal(opens.length, 1);
  for (const dispose of disposers.reverse()) dispose();
  assert.equal(registrations.length, 0); assert.equal(definitions.length, 0);
});
