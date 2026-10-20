/* Touch- and pen-friendly date and time pickers (same design as the Pinebridge app's picker).
 *
 * Native <input type="date|time"> opens the device's own picker, which looks different on
 * every phone and computer. PenPicker.enhance(input) turns an <input> into a button that
 * opens an in-page picker with large tap targets and an always-visible Set button.
 *
 * The original <input> keeps its id and value ("YYYY-MM-DD" or "HH:MM"), so code can keep
 * reading and writing input.value; writing it updates the button text automatically.
 */
(function () {
  'use strict';

  var MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  var MONTHS_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  var WEEKDAYS = ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su'];
  var ITEM_H = 40;
  var LIST_H = 200;
  var ICONS = {
    calendar: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/></svg>',
    clock: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/></svg>',
    left: '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 18l-6-6 6-6"/></svg>',
    right: '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 18l6-6-6-6"/></svg>',
    up: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 15l-6-6-6 6"/></svg>',
    down: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 9l6 6 6-6"/></svg>'
  };
  var valueDesc = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
  var current = null; // the open picker, if any

  function pad2(n) { return (n < 10 ? '0' : '') + n; }
  function fmtDate(y, m, d) { return y + '-' + pad2(m) + '-' + pad2(d); }
  function parseDate(v) {
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v || '');
    if (!m) return null;
    var p = { y: +m[1], m: +m[2], d: +m[3] };
    var dt = new Date(p.y, p.m - 1, p.d);
    if (dt.getFullYear() !== p.y || dt.getMonth() !== p.m - 1 || dt.getDate() !== p.d) return null;
    return p;
  }
  function parseTime(v) {
    var m = /^(\d{1,2}):(\d{1,2})/.exec(v || '');
    if (m) return { h: Math.min(23, +m[1]), m: Math.min(59, +m[2]) };
    var now = new Date();
    return { h: now.getHours(), m: now.getMinutes() };
  }
  function displayDate(v) {
    var p = parseDate(v);
    return p ? pad2(p.d) + ' ' + MONTHS_SHORT[p.m - 1] + ' ' + p.y : '';
  }
  function el(tag, cls, html) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (html != null) e.innerHTML = html;
    return e;
  }
  function button(cls, html, label) {
    var b = el('button', cls, html);
    b.type = 'button';
    if (label) b.setAttribute('aria-label', label);
    return b;
  }

  // ---------- Popover shell ----------
  function openPopover(input, trigger, width, label, build) {
    close();
    var host = trigger.closest('.overlay') || document.body;
    var backdrop = el('div', 'pp-backdrop');
    var card = el('div', 'pp-card');
    card.setAttribute('role', 'dialog');
    card.setAttribute('aria-modal', 'true');
    card.setAttribute('aria-label', label);
    host.appendChild(backdrop);
    host.appendChild(card);

    function place() {
      var a = trigger.getBoundingClientRect();
      var vw = window.innerWidth, vh = window.innerHeight;
      var cw = Math.min(width, vw - 16);
      card.style.width = cw + 'px';
      var ch = card.offsetHeight || 340;
      var left = Math.max(8, Math.min(a.left, vw - 8 - cw));
      var top = a.bottom + 6;
      if (top + ch > vh - 8) {
        var above = a.top - 6 - ch;
        top = above >= 8 ? above : Math.max(8, vh - 8 - ch);
      }
      card.style.left = left + 'px';
      card.style.top = top + 'px';
      card.style.visibility = 'visible';
    }
    function onKey(e) {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); return; }
      if (e.key !== 'Tab') return;
      e.stopPropagation(); // keep the surrounding dialog's focus trap out of it
      var f = Array.prototype.filter.call(card.querySelectorAll('button:not([disabled]), select:not([disabled])'), function (x) { return x.getClientRects().length; });
      if (!f.length) return;
      if (e.shiftKey && document.activeElement === f[0]) { e.preventDefault(); f[f.length - 1].focus(); }
      else if (!e.shiftKey && document.activeElement === f[f.length - 1]) { e.preventDefault(); f[0].focus(); }
    }
    function onScroll(e) { if (!card.contains(e.target)) place(); }

    current = {
      close: function () {
        backdrop.remove();
        card.remove();
        window.removeEventListener('resize', place);
        window.removeEventListener('scroll', onScroll, true);
        current = null;
        trigger.focus({ preventScroll: true });
      }
    };
    backdrop.addEventListener('click', close);
    card.addEventListener('keydown', onKey);
    window.addEventListener('resize', place);
    window.addEventListener('scroll', onScroll, true);

    build(card);
    place();
    var first = card.querySelector('.pp-selected') || card.querySelector('button:not([disabled])');
    if (first) first.focus({ preventScroll: true });
  }

  function close() { if (current) current.close(); }

  function footer(card, onSet, extra) {
    var f = el('div', 'pp-footer');
    var left = el('div', 'pp-footer-left');
    if (extra) left.appendChild(extra);
    f.appendChild(left);
    var cancel = button('pp-btn pp-btn-secondary', 'Cancel');
    var set = button('pp-btn pp-btn-primary', 'Set');
    cancel.addEventListener('click', close);
    set.addEventListener('click', onSet);
    f.appendChild(cancel);
    f.appendChild(set);
    card.appendChild(f);
    return set;
  }

  // ---------- Date panel ----------
  function datePanel(card, value, commit) {
    var now = new Date();
    var sel = parseDate(value);
    var init = sel || { y: now.getFullYear(), m: now.getMonth() + 1, d: now.getDate() };
    var viewY = init.y, viewM = init.m;
    var todayStr = fmtDate(now.getFullYear(), now.getMonth() + 1, now.getDate());

    var head = el('div', 'pp-head');
    var prev = button('pp-nav', ICONS.left, 'Previous month');
    var next = button('pp-nav', ICONS.right, 'Next month');
    var selects = el('div', 'pp-selects');
    var monthSel = el('select', 'pp-select pp-month');
    monthSel.setAttribute('aria-label', 'Select month');
    MONTHS.forEach(function (m, i) { var o = el('option', null, m); o.value = String(i + 1); monthSel.appendChild(o); });
    var yearSel = el('select', 'pp-select pp-year');
    yearSel.setAttribute('aria-label', 'Select year');
    selects.appendChild(monthSel);
    selects.appendChild(yearSel);
    head.appendChild(prev); head.appendChild(selects); head.appendChild(next);
    card.appendChild(head);

    var body = el('div', 'pp-body');
    var dow = el('div', 'pp-grid pp-dow');
    WEEKDAYS.forEach(function (w) { dow.appendChild(el('div', null, w)); });
    var grid = el('div', 'pp-grid pp-days');
    body.appendChild(dow); body.appendChild(grid);
    card.appendChild(body);

    var today = button('pp-link', 'Today');
    var setBtn = footer(card, function () {
      if (!sel) { close(); return; }
      commit(fmtDate(sel.y, sel.m, sel.d));
      close();
    }, today);

    function fillYears() {
      var first = Math.min(now.getFullYear() - 100, viewY), last = Math.max(now.getFullYear() + 50, viewY);
      if (+yearSel.getAttribute('data-first') === first && +yearSel.getAttribute('data-last') === last) return;
      yearSel.innerHTML = '';
      for (var y = first; y <= last; y++) { var o = el('option', null, String(y)); o.value = String(y); yearSel.appendChild(o); }
      yearSel.setAttribute('data-first', first); yearSel.setAttribute('data-last', last);
    }

    function draw() {
      fillYears();
      monthSel.value = String(viewM);
      yearSel.value = String(viewY);
      grid.innerHTML = '';
      var offset = (new Date(viewY, viewM - 1, 1).getDay() + 6) % 7;
      var days = new Date(viewY, viewM, 0).getDate();
      for (var i = 0; i < offset; i++) grid.appendChild(el('div'));
      for (var d = 1; d <= days; d++) {
        var s = fmtDate(viewY, viewM, d);
        var isSel = !!sel && sel.y === viewY && sel.m === viewM && sel.d === d;
        var b = button('pp-day' + (isSel ? ' pp-selected' : '') + (s === todayStr ? ' pp-today' : ''), String(d),
          new Date(viewY, viewM - 1, d).toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }));
        b.setAttribute('aria-pressed', String(isSel));
        b.setAttribute('data-day', String(d));
        grid.appendChild(b);
      }
      setBtn.disabled = !sel;
    }

    function changeView(y, m) {
      viewY = y; viewM = m;
      if (sel) sel = { y: y, m: m, d: Math.min(sel.d, new Date(y, m, 0).getDate()) };
      draw();
    }

    grid.addEventListener('click', function (e) {
      var b = e.target.closest('[data-day]');
      if (!b) return;
      sel = { y: viewY, m: viewM, d: +b.getAttribute('data-day') };
      draw();
      var again = grid.querySelector('.pp-selected');
      if (again) again.focus({ preventScroll: true });
    });
    prev.addEventListener('click', function () { changeView(viewM === 1 ? viewY - 1 : viewY, viewM === 1 ? 12 : viewM - 1); });
    next.addEventListener('click', function () { changeView(viewM === 12 ? viewY + 1 : viewY, viewM === 12 ? 1 : viewM + 1); });
    monthSel.addEventListener('change', function () { changeView(viewY, +monthSel.value); });
    yearSel.addEventListener('change', function () { changeView(+yearSel.value, viewM); });
    today.addEventListener('click', function () {
      viewY = now.getFullYear(); viewM = now.getMonth() + 1;
      sel = { y: viewY, m: viewM, d: now.getDate() };
      draw();
    });
    draw();
  }

  // ---------- Time panel ----------
  function timePanel(card, value, commit) {
    var t = parseTime(value);
    var hour = t.h, minute = t.m;
    var big = el('div', 'pp-time-display');
    card.appendChild(big);
    var cols = el('div', 'pp-time-cols');
    card.appendChild(cols);

    function column(label, count, get, set) {
      var col = el('div', 'pp-time-col');
      col.appendChild(el('div', 'pp-col-label', label));
      var up = button('pp-step', ICONS.up, label + ' previous');
      var list = el('div', 'pp-list');
      for (var i = 0; i < count; i++) {
        var b = button('pp-item', pad2(i), label + ' ' + pad2(i));
        b.setAttribute('data-i', String(i));
        list.appendChild(b);
      }
      var down = button('pp-step', ICONS.down, label + ' next');
      col.appendChild(up); col.appendChild(list); col.appendChild(down);
      cols.appendChild(col);
      function choose(i, scroll) {
        set((i + count) % count);
        Array.prototype.forEach.call(list.children, function (b, idx) {
          b.classList.toggle('pp-selected', idx === get());
          b.setAttribute('aria-pressed', String(idx === get()));
        });
        if (scroll) list.scrollTop = Math.max(0, get() * ITEM_H - (LIST_H / 2 - ITEM_H / 2));
        big.textContent = pad2(hour) + ' : ' + pad2(minute);
      }
      up.addEventListener('click', function () { choose(get() - 1, true); });
      down.addEventListener('click', function () { choose(get() + 1, true); });
      list.addEventListener('click', function (e) {
        var b = e.target.closest('[data-i]');
        if (b) choose(+b.getAttribute('data-i'), true);
      });
      return function () { choose(get(), true); };
    }

    var initH = column('Hour', 24, function () { return hour; }, function (v) { hour = v; });
    var initM = column('Minute', 60, function () { return minute; }, function (v) { minute = v; });
    footer(card, function () { commit(pad2(hour) + ':' + pad2(minute)); close(); });
    // Centre the selected values once the card is in the page.
    requestAnimationFrame(function () { initH(); initM(); });
    initH(); initM();
  }

  // ---------- Public ----------
  function enhance(input) {
    var kind = input.getAttribute('type') === 'time' ? 'time' : 'date';
    var placeholder = kind === 'time' ? 'Select time' : 'Select date';
    var trigger = button('pp-trigger');
    trigger.id = input.id + 'Btn';
    var text = el('span', 'pp-trigger-text');
    trigger.appendChild(text);
    trigger.appendChild(el('span', 'pp-trigger-icon', kind === 'time' ? ICONS.clock : ICONS.calendar));
    input.type = 'hidden';
    input.parentNode.insertBefore(trigger, input);

    function refresh() {
      var v = valueDesc.get.call(input);
      var shown = kind === 'time' ? (v || '') : displayDate(v);
      text.textContent = shown || placeholder;
      trigger.classList.toggle('pp-empty', !shown);
    }
    Object.defineProperty(input, 'value', {
      configurable: true,
      get: function () { return valueDesc.get.call(input); },
      set: function (v) { valueDesc.set.call(input, v); refresh(); }
    });
    function commit(v) {
      input.value = v;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
    }
    trigger.addEventListener('click', function () {
      if (current) { close(); return; }
      if (kind === 'time') openPopover(input, trigger, 260, 'Time picker', function (card) { timePanel(card, input.value, commit); });
      else openPopover(input, trigger, 320, 'Date picker', function (card) { datePanel(card, input.value, commit); });
    });
    refresh();
    return trigger;
  }

  window.PenPicker = { enhance: enhance, close: close };
})();
