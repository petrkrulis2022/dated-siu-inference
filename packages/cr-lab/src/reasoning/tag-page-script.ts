import { TAG_RULES_SOURCE } from "./schemes.js";

/**
 * The tagging page's script. It runs the same clicking rules the tests run (`TAG_RULES_SOURCE`), keeps answers in this browser as it goes (resuming at the first passage not yet tagged), and at the
 * end offers the tags as a file to download. It makes no network request. No template literal appears inside, so the text can be embedded as it is.
 */
export const TAG_PAGE_SCRIPT = `
${TAG_RULES_SOURCE}
(function () {
  var data = JSON.parse(document.getElementById('data').textContent);
  var scheme = data.scheme, items = data.items, mode = data.mode;
  var storeKey = 'touchstone-tagging-' + scheme.id + '-' + mode + '-' + data.sampleSha256.slice(0, 12);
  var tags = {};
  var at = 0;
  var el = function (id) { return document.getElementById(id); };
  var box = el('options');

  function store(write, value) {
    try {
      if (write) localStorage.setItem(storeKey, JSON.stringify(value));
      else return JSON.parse(localStorage.getItem(storeKey) || 'null');
    } catch (e) { return null; }
    return null;
  }

  function option(inputId, value, title, text, extra) {
    var label = document.createElement('label'); label.className = 'opt' + (extra ? ' ' + extra : '');
    var input = document.createElement('input'); input.type = 'checkbox'; input.id = inputId; input.value = value;
    var t = document.createElement('div'); t.className = 't';
    var strong = document.createElement('strong'); strong.textContent = title;
    var span = document.createElement('span'); span.textContent = text;
    t.appendChild(strong); t.appendChild(span); label.appendChild(input); label.appendChild(t); box.appendChild(label);
    return input;
  }

  var KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0'];
  var inputs = [];
  var noneInput = null;
  var keyOf = {};
  scheme.categories.forEach(function (c, i) {
    var isNone = c.id === scheme.noneId;
    var key = isNone ? 'n' : KEYS[i];
    keyOf[key] = c.id;
    var input = option('cat-' + c.id, c.id, (isNone ? '' : (key + '. ')) + c.name + (isNone ? ' (n)' : ''), c.meaning, isNone ? 'none' : '');
    input.addEventListener('change', function () { apply({ kind: 'cat', id: c.id, on: input.checked }); });
    inputs.push(input);
    if (isNone) noneInput = input;
  });
  var flagInput = null;
  if (scheme.flag) {
    flagInput = option('cat-flag', scheme.flag.id, 'a. ' + scheme.flag.name, scheme.flag.meaning);
    flagInput.addEventListener('change', function () { apply({ kind: 'flag', on: flagInput.checked }); });
  }

  function current() {
    return { ids: inputs.filter(function (i) { return i.checked; }).map(function (i) { return i.value; }), flag: !!flagInput && flagInput.checked };
  }
  function write(t) {
    inputs.forEach(function (inp) { inp.checked = !!t && t.ids.indexOf(inp.value) !== -1; });
    if (flagInput) flagInput.checked = !!t && !!t.flag;
  }
  function apply(changed) { write(applyChoice(scheme, current(), changed)); refresh(); }
  function refresh() { el('next').disabled = !isAnswered(current()); }

  function show(i) {
    at = i;
    el('passage').textContent = items[i].text;
    el('rid').textContent = items[i].id;
    el('count').textContent = 'Passage ' + (i + 1) + ' of ' + items.length;
    el('bar').style.width = (100 * i / items.length) + '%';
    write(tags[items[i].id]);
    el('back').disabled = i === 0;
    el('next').textContent = i === items.length - 1 ? 'Finish' : 'Next';
    refresh();
    el('card').hidden = false; el('done').hidden = true;
    window.scrollTo(0, 0);
  }

  function output() {
    return JSON.stringify({
      scheme: scheme.id, mode: mode, sample_sha256: data.sampleSha256, taggedAt: new Date().toISOString(),
      tags: items.map(function (it) { var t = tags[it.id] || { ids: [], flag: false }; return { id: it.id, categories: t.ids, flag: t.flag }; })
    }, null, 2);
  }

  function finish() {
    el('card').hidden = true; el('done').hidden = false; el('bar').style.width = '100%';
    el('dump').value = output();
  }

  el('next').addEventListener('click', function () {
    tags[items[at].id] = current(); store(true, tags);
    if (at === items.length - 1) finish(); else show(at + 1);
  });
  el('back').addEventListener('click', function () {
    if (at > 0) { if (isAnswered(current())) { tags[items[at].id] = current(); store(true, tags); } show(at - 1); }
  });
  el('review').addEventListener('click', function () { show(0); });
  el('copy').addEventListener('click', function () {
    var d = el('dump'); d.hidden = false; d.focus(); d.select();
    try { navigator.clipboard.writeText(d.value); } catch (e) { /* the text is selected: copy by hand */ }
  });
  el('download').addEventListener('click', function () {
    var blob = new Blob([output()], { type: 'application/json' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'tags-' + scheme.id + '-' + mode + '.json';
    document.body.appendChild(a); a.click(); a.remove();
  });
  document.addEventListener('keydown', function (e) {
    if (el('card').hidden || e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key === 'Enter' && !el('next').disabled && document.activeElement && document.activeElement.tagName !== 'BUTTON') { el('next').click(); e.preventDefault(); return; }
    var k = e.key.toLowerCase();
    var target = keyOf[k] ? inputs.filter(function (i) { return i.value === keyOf[k]; })[0] : (k === 'a' ? flagInput : null);
    if (target) { target.click(); e.preventDefault(); }
  });

  var saved = store(false) || {};
  items.forEach(function (it) {
    var v = saved[it.id];
    if (v && isAnswered({ ids: v.ids || [], flag: !!v.flag })) tags[it.id] = { ids: v.ids || [], flag: !!v.flag };
  });
  var first = items.findIndex(function (it) { return !tags[it.id]; });
  if (first === -1) finish(); else show(first);
})();
`;
