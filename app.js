/* Personal Organiser — standalone recurring-task app.
 *
 * Data lives in this browser (localStorage). When a Google account is connected:
 *  - tasks/lists are synced between devices through a JSON file in the user's
 *    Google Drive appDataFolder (hidden, app-only), merged record-by-record;
 *  - each task is mirrored as a repeating Google Calendar event.
 *
 * Sync model: every list/task carries `updatedAt` (ms). Deletions are kept as
 * tombstones (`deleted: true`) so they propagate. Merge = newest `updatedAt`
 * wins per record; the calendar link (googleEventId/calSig) is merged
 * separately by `calAt` so a calendar sync on one device never overwrites a
 * content edit made on another.
 */
(function () {
  'use strict';

  var STORE_KEY = 'personalOrganiser.data.v1';
  var FIRED_KEY = 'personalOrganiser.fired.v1';
  var DATA_FILE = 'organiser-data.json';
  var DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  var RRULE_DAYS = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];
  var CAL_SCOPE = 'https://www.googleapis.com/auth/calendar.events';
  var DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.appdata';
  var CAL_API = 'https://www.googleapis.com/calendar/v3';
  var DRIVE_API = 'https://www.googleapis.com/drive/v3';
  var DRIVE_UPLOAD = 'https://www.googleapis.com/upload/drive/v3';
  var TOMBSTONE_TTL = 60 * 24 * 3600 * 1000;
  var COLUMNS = [
    { type: 'daily', title: 'Daily Tasks' },
    { type: 'weekly', title: 'Weekly Tasks' },
    { type: 'monthly', title: 'Monthly Tasks' }
  ];

  // ---------- Utilities ----------
  function $(id) { return document.getElementById(id); }
  function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function pad(n) { return (n < 10 ? '0' : '') + n; }
  function localDateKey(d) { return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
  function localDateTime(d) { return localDateKey(d) + 'T' + pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':00'; }
  function clock(ms) { var d = new Date(ms); return pad(d.getHours()) + ':' + pad(d.getMinutes()); }
  function toMs(v) { if (typeof v === 'number') return v; var n = Date.parse(v); return isNaN(n) ? 0 : n; }
  function timeZone() {
    try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch (e) { return 'UTC'; }
  }
  function live(arr) { return arr.filter(function (x) { return !x.deleted; }); }
  function plural(n, word) { return n + ' ' + word + (n === 1 ? '' : 's'); }

  // ---------- Storage ----------
  function seedList() { return { id: uid(), name: 'Personal', seed: true, updatedAt: 0 }; }

  function defaultState() {
    return {
      version: 2,
      lists: [seedList()],
      tasks: [],
      shared: { reminderMinutes: 0, updatedAt: 0 },
      settings: { googleClientId: '', connected: false, lastSyncAt: 0, driveFileId: null }
    };
  }

  // Normalises v1 data (and v1 backups) into the v2 shape.
  function normalise(d) {
    var def = defaultState();
    var out = {
      version: 2,
      lists: (d.lists || []).map(function (l) {
        return { id: String(l.id), name: String(l.name || 'List'), seed: !!l.seed, deleted: !!l.deleted, updatedAt: toMs(l.updatedAt) };
      }),
      tasks: (d.tasks || []).map(function (t) {
        var n = Object.assign({}, t);
        n.id = String(t.id);
        n.updatedAt = toMs(t.updatedAt || t.createdAt);
        n.deleted = !!t.deleted;
        n.googleEventId = t.googleEventId || null;
        n.calSig = t.calSig || null;
        n.calAt = toMs(t.calAt);
        delete n.syncState;
        return n;
      }),
      shared: Object.assign({}, def.shared, d.shared || {}),
      settings: Object.assign({}, def.settings, d.settings || {})
    };
    if (d.settings && d.settings.calendarEnabled) out.settings.connected = true; // v1 flag
    delete out.settings.calendarEnabled;
    if (d.settings && d.settings.reminderMinutes != null && !d.shared) out.shared.reminderMinutes = Number(d.settings.reminderMinutes) || 0;
    delete out.settings.reminderMinutes;
    if (!live(out.lists).length) out.lists.push(seedList());
    return out;
  }

  function loadState() {
    try {
      var raw = localStorage.getItem(STORE_KEY);
      if (!raw) return defaultState();
      var d = JSON.parse(raw);
      if (!d || !Array.isArray(d.tasks) || !Array.isArray(d.lists)) return defaultState();
      return normalise(d);
    } catch (e) {
      console.error('Could not read saved data', e);
      return defaultState();
    }
  }

  var state = loadState();
  var ui = { listFilter: 'all', tab: 'daily', editingId: null };
  // View preferences are separate from the synced task data.
  ui.view = 'calendar';
  try { if (localStorage.getItem('personalOrganiser.view') === 'tasks') ui.view = 'tasks'; } catch (e) { /* preference is optional */ }
  ui.month = new Date(new Date().getFullYear(), new Date().getMonth(), 1);
  ui.selectedDate = localDateKey(new Date());

  function save() {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify(state));
    } catch (e) {
      toast('Could not save on this device: ' + e.message, true);
      throw e;
    }
  }

  // Call after any user change so it gets saved and sent to other devices.
  function commit() {
    save();
    render();
    scheduleSync();
  }

  function liveLists() { return live(state.lists); }
  function liveTasks() { return live(state.tasks); }
  function findList(id) { return state.lists.find(function (l) { return l.id === id; }); }
  function listName(id) { var l = findList(id); return l ? l.name : 'Unlisted'; }

  // ---------- Toast ----------
  var toastTimer = null;
  function toast(msg, isError) {
    var t = $('toast');
    t.textContent = msg;
    t.className = 'toast' + (isError ? ' error' : '');
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.hidden = true; }, isError ? 6000 : 3000);
  }

  // ---------- Confirm ----------
  function confirmDialog(title, text, okLabel) {
    return new Promise(function (resolve) {
      $('confirmTitle').textContent = title;
      $('confirmText').textContent = text;
      $('confirmOk').textContent = okLabel || 'Delete';
      var ov = $('confirmOverlay');
      ov.hidden = false;
      function done(v) {
        ov.hidden = true;
        $('confirmOk').onclick = null;
        $('confirmCancel').onclick = null;
        resolve(v);
      }
      $('confirmOk').onclick = function () { done(true); };
      $('confirmCancel').onclick = function () { done(false); };
    });
  }

  // ---------- Schedule helpers ----------
  function formatSchedule(t) {
    if (t.scheduleType === 'daily') return (t.weekdaysOnly ? 'Weekdays at ' : 'Daily at ') + t.scheduleTime;
    if (t.scheduleType === 'weekly') return DAYS[t.scheduleDayOfWeek || 0] + ' at ' + t.scheduleTime;
    return 'Day ' + t.scheduleDayOfMonth + ' at ' + t.scheduleTime;
  }

  function occursOn(t, d) {
    if (t.scheduleType === 'daily') {
      var dow = d.getDay();
      return !t.weekdaysOnly || (dow >= 1 && dow <= 5);
    }
    if (t.scheduleType === 'weekly') return d.getDay() === Number(t.scheduleDayOfWeek);
    return d.getDate() === Number(t.scheduleDayOfMonth);
  }

  function nextOccurrence(t, from) {
    var parts = t.scheduleTime.split(':');
    var d = new Date(from.getTime());
    d.setHours(Number(parts[0]), Number(parts[1]), 0, 0);
    for (var i = 0; i < 400; i++) {
      if (occursOn(t, d) && d.getTime() >= from.getTime()) return d;
      d.setDate(d.getDate() + 1);
      d.setHours(Number(parts[0]), Number(parts[1]), 0, 0);
    }
    return d;
  }

  function buildRRule(t) {
    if (t.scheduleType === 'daily') return t.weekdaysOnly ? 'RRULE:FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR' : 'RRULE:FREQ=DAILY';
    if (t.scheduleType === 'weekly') return 'RRULE:FREQ=WEEKLY;BYDAY=' + RRULE_DAYS[Number(t.scheduleDayOfWeek) || 0];
    return 'RRULE:FREQ=MONTHLY;BYMONTHDAY=' + Number(t.scheduleDayOfMonth);
  }

  function eventTitle(t) {
    return (liveLists().length > 1 ? '[' + listName(t.listId) + '] ' : '') + t.taskName;
  }

  // Everything that appears in the calendar event. If it changes, the event must be updated.
  function calSig(t) {
    return JSON.stringify([eventTitle(t), t.description || '', t.priority, t.status, t.scheduleType, t.scheduleTime,
      t.scheduleDayOfWeek, t.scheduleDayOfMonth, !!t.weekdaysOnly, Number(state.shared.reminderMinutes) || 0]);
  }

  function calendarUpToDate(t) { return !!t.googleEventId && t.calSig === calSig(t); }

  // ---------- Rendering ----------
  function renderListFilter() {
    var sel = $('listFilter');
    var lists = liveLists();
    var html = '<option value="all">All lists</option>';
    lists.forEach(function (l) { html += '<option value="' + esc(l.id) + '">' + esc(l.name) + '</option>'; });
    sel.innerHTML = html;
    if (ui.listFilter !== 'all' && !lists.some(function (l) { return l.id === ui.listFilter; })) ui.listFilter = 'all';
    sel.value = ui.listFilter;
  }

  function visibleTasks() {
    return liveTasks().filter(function (t) { return ui.listFilter === 'all' || t.listId === ui.listFilter; });
  }

  function syncFlag(t) {
    if (!state.settings.connected) return '';
    if (calendarUpToDate(t)) return '<span class="sync-flag">In Calendar</span>';
    return '<span class="sync-flag pending">Calendar update pending</span>';
  }

  function renderTask(t) {
    var showList = ui.listFilter === 'all' && liveLists().length > 1;
    return '<article class="task' + (t.status === 'completed' ? ' completed' : '') + '" data-id="' + esc(t.id) + '" tabindex="0" aria-label="' + esc(t.taskName + ', ' + formatSchedule(t) + '. Press Enter to edit.') + '">' +
      '<div class="task-top"><div style="min-width:0">' +
      '<h3 class="task-name">' + esc(t.taskName) + '</h3>' +
      (t.description ? '<p class="task-desc" title="' + esc(t.description) + '">' + esc(t.description) + '</p>' : '') +
      '<div class="task-meta"><span>' + esc(formatSchedule(t)) + '</span>' +
      (showList ? '<span>' + esc(listName(t.listId)) + '</span>' : '') + syncFlag(t) + '</div>' +
      '</div><div class="badges">' +
      '<span class="badge p-' + esc(t.priority) + '">' + esc(t.priority) + '</span>' +
      '<span class="badge s-' + esc(t.status) + '">' + esc(String(t.status).replace('_', ' ')) + '</span>' +
      '</div></div>' +
      '<div class="task-actions">' +
      '<button type="button" class="btn btn-dark btn-sm" data-action="edit" data-id="' + esc(t.id) + '">Edit</button>' +
      '<button type="button" class="btn btn-danger-outline btn-sm" data-action="delete" data-id="' + esc(t.id) + '">Delete</button>' +
      '</div></article>';
  }

  function render() {
    renderListFilter();
    $('calendarView').hidden = ui.view !== 'calendar';
    $('tasksView').hidden = ui.view !== 'tasks';
    document.querySelectorAll('[data-view]').forEach(function (b) {
      var active = b.getAttribute('data-view') === ui.view;
      b.classList.toggle('active', active);
      b.setAttribute('aria-pressed', String(active));
    });
    renderCalendar();
    var tasks = visibleTasks();
    var html = '';
    COLUMNS.forEach(function (c) {
      var col = tasks.filter(function (t) { return t.scheduleType === c.type; })
        .sort(function (a, b) { return a.scheduleTime.localeCompare(b.scheduleTime); });
      html += '<div class="column' + (ui.tab === c.type ? ' active' : '') + '" data-type="' + c.type + '">' +
        '<div class="column-header"><div class="column-title">' + c.title + ' <span class="count">' + col.length + '</span></div>' +
        '<button type="button" class="btn btn-primary btn-sm" data-action="add" data-type="' + c.type + '">+ Add Task</button></div>' +
        '<div class="column-body">' +
         (col.length ? col.map(renderTask).join('') : '<div class="empty"><span class="empty-mark" aria-hidden="true">+</span><strong>A little room for a routine</strong><p>No ' + c.title.toLowerCase() + ' yet. Add something you want to keep on track.</p><button type="button" class="btn btn-dark" data-action="add" data-type="' + c.type + '">Add a ' + c.type + ' task</button></div>') +
        '</div></div>';
    });
    $('columns').innerHTML = html;
    document.querySelectorAll('#mobileTabs button').forEach(function (b) {
      b.classList.toggle('active', b.getAttribute('data-tab') === ui.tab);
      b.setAttribute('aria-selected', String(b.getAttribute('data-tab') === ui.tab));
    });
    renderSyncStatus();
  }

  // ---------- Calendar presentation (no occurrence-specific state) ----------
  function dateFromKey(key) {
    var parts = key.split('-');
    return new Date(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]));
  }

  function tasksOn(date) {
    return visibleTasks().filter(function (t) { return occursOn(t, date); })
      .sort(function (a, b) { return a.scheduleTime.localeCompare(b.scheduleTime) || a.taskName.localeCompare(b.taskName); });
  }

  function renderCalendar() {
    var month = ui.month;
    var today = localDateKey(new Date());
    $('monthTitle').textContent = month.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
    var start = new Date(month.getFullYear(), month.getMonth(), 1 - month.getDay());
    var weeks = Math.ceil((month.getDay() + new Date(month.getFullYear(), month.getMonth() + 1, 0).getDate()) / 7);
    var html = '';
    for (var i = 0; i < weeks * 7; i++) {
      var day = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i);
      var key = localDateKey(day);
      var tasks = tasksOn(day);
      var label = day.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
      html += '<div class="calendar-cell' + (day.getMonth() !== month.getMonth() ? ' outside' : '') +
        (key === today ? ' is-today' : '') + (key === ui.selectedDate ? ' selected' : '') + '">' +
        '<button type="button" class="day-select" data-date="' + key + '" aria-label="' + esc(label + ', ' + plural(tasks.length, 'task')) +
        '" aria-pressed="' + (key === ui.selectedDate) + '"' + (key === today ? ' aria-current="date"' : '') +
        '><span class="day-number">' + day.getDate() + '</span><span class="mobile-day-count">' + (tasks.length ? tasks.length + (tasks.length === 1 ? ' task' : ' tasks') : '') + '</span></button>' +
        '<div class="calendar-events">';
      tasks.slice(0, 3).forEach(function (t) {
        html += '<button type="button" class="event-chip p-' + esc(t.priority) + (t.status === 'completed' ? ' completed' : '') +
          '" data-edit-task="' + esc(t.id) + '" title="' + esc(t.scheduleTime + ' ' + t.taskName + ' · ' + listName(t.listId)) +
          '"><span>' + esc(t.scheduleTime) + '</span> ' + esc(t.taskName) + '</button>';
      });
      if (tasks.length > 3) html += '<button type="button" class="more-events" data-date="' + key + '" data-show-agenda="true">+' + (tasks.length - 3) + ' more</button>';
      html += '</div><div class="mobile-dots" aria-hidden="true">';
      tasks.slice(0, 4).forEach(function (t) { html += '<i class="dot p-' + esc(t.priority) + (t.status === 'completed' ? ' completed' : '') + '"></i>'; });
      html += '</div></div>';
    }
    $('calendarGrid').innerHTML = html;
    var selected = dateFromKey(ui.selectedDate);
    $('agendaTitle').textContent = selected.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
    var agenda = tasksOn(selected);
    $('agendaTasks').innerHTML = agenda.length ? agenda.map(function (t) {
      return '<button type="button" class="agenda-item' + (t.status === 'completed' ? ' completed' : '') + '" data-edit-task="' + esc(t.id) + '">' +
        '<span class="agenda-time">' + esc(t.scheduleTime) + '</span><i class="dot p-' + esc(t.priority) + '" aria-hidden="true"></i>' +
        '<span class="agenda-details"><strong>' + esc(t.taskName) + '</strong><span>' + esc(listName(t.listId)) + ' · ' + esc(formatSchedule(t)) + '</span></span>' +
        '<span class="agenda-status">' + esc(String(t.status).replace('_', ' ')) + '</span><span class="agenda-chevron" aria-hidden="true">&#8250;</span></button>';
    }).join('') : '<div class="agenda-empty"><span class="empty-mark" aria-hidden="true">—</span><div><strong>A little breathing room.</strong><p>' +
      (visibleTasks().length ? 'No tasks scheduled for this day.' : (liveTasks().length ? 'No tasks in this list yet. Choose another list or add a routine.' : 'Start with one small routine. Add your first task to see it on the calendar.')) +
      '</p></div></div>';
  }

  function addTaskForDay() {
    var day = dateFromKey(ui.selectedDate);
    openTaskModal(null, 'weekly');
    $('fDayOfWeek').value = String(day.getDay());
    $('fDayOfMonth').value = String(day.getDate());
  }

  // ---------- Task modal ----------
  function fillSelectors() {
    $('fDayOfWeek').innerHTML = DAYS.map(function (d, i) { return '<option value="' + i + '">' + d + '</option>'; }).join('');
    var dom = '';
    for (var i = 1; i <= 31; i++) dom += '<option value="' + i + '">' + i + '</option>';
    $('fDayOfMonth').innerHTML = dom;
  }

  function updateScheduleFields() {
    var type = $('fScheduleType').value;
    $('weekdaysWrap').hidden = type !== 'daily';
    $('dowWrap').hidden = type !== 'weekly';
    $('domWrap').hidden = type !== 'monthly';
  }

  function openTaskModal(task, type) {
    ui.editingId = task ? task.id : null;
    var lists = liveLists();
    $('taskModalTitle').textContent = task ? 'Edit Task' : 'Add Task';
    $('saveTaskBtn').textContent = task ? 'Update' : 'Create';
    $('deleteTaskBtn').hidden = !task;
    $('taskFormError').hidden = true;
    $('fList').innerHTML = lists.map(function (l) { return '<option value="' + esc(l.id) + '">' + esc(l.name) + '</option>'; }).join('');
    var defaultList = ui.listFilter !== 'all' ? ui.listFilter : lists[0].id;
    $('fTaskName').value = task ? task.taskName : '';
    $('fDescription').value = task ? (task.description || '') : '';
    $('fList').value = task ? task.listId : defaultList;
    if (!$('fList').value) $('fList').value = lists[0].id;
    $('fPriority').value = task ? task.priority : 'medium';
    $('fStatus').value = task ? task.status : 'pending';
    $('fScheduleType').value = task ? task.scheduleType : (type || 'daily');
    $('fTime').value = task ? task.scheduleTime : '09:00';
    $('fWeekdays').checked = task ? !!task.weekdaysOnly : true;
    $('fDayOfWeek').value = String(task && task.scheduleDayOfWeek != null ? task.scheduleDayOfWeek : 1);
    $('fDayOfMonth').value = String(task && task.scheduleDayOfMonth != null ? task.scheduleDayOfMonth : 1);
    updateScheduleFields();
    $('taskOverlay').hidden = false;
    setTimeout(function () { $('fTaskName').focus(); }, 50);
  }

  function closeOverlay(id) { $(id).hidden = true; }

  function submitTask(e) {
    e.preventDefault();
    var name = $('fTaskName').value.trim();
    var time = $('fTime').value;
    var err = $('taskFormError');
    if (!name) { err.textContent = 'Please enter a task name.'; err.hidden = false; return; }
    if (!/^\d{2}:\d{2}$/.test(time)) { err.textContent = 'Please choose a time.'; err.hidden = false; return; }
    var type = $('fScheduleType').value;
    var desc = $('fDescription').value.trim();
    var data = {
      listId: $('fList').value,
      taskName: name,
      description: desc || null,
      priority: $('fPriority').value,
      status: $('fStatus').value,
      scheduleType: type,
      scheduleTime: time,
      scheduleDayOfWeek: type === 'weekly' ? Number($('fDayOfWeek').value) : null,
      scheduleDayOfMonth: type === 'monthly' ? Number($('fDayOfMonth').value) : null,
      weekdaysOnly: type === 'daily' ? $('fWeekdays').checked : false,
      updatedAt: Date.now()
    };
    var editing = !!ui.editingId;
    if (editing) {
      var task = state.tasks.find(function (t) { return t.id === ui.editingId && !t.deleted; });
      if (!task) { err.textContent = 'This task was deleted (possibly on another device).'; err.hidden = false; return; }
      Object.assign(task, data);
    } else {
      state.tasks.push(Object.assign({ id: uid(), createdAt: Date.now(), deleted: false, googleEventId: null, calSig: null, calAt: 0 }, data));
    }
    var list = findList(data.listId);
    if (list && list.seed) { list.seed = false; list.updatedAt = Date.now(); }
    ui.tab = type;
    closeOverlay('taskOverlay');
    commit();
    toast(editing ? 'Task updated' : 'Task created');
  }

  function tombstoneTask(t, now) {
    var keep = { id: t.id, deleted: true, updatedAt: now, googleEventId: t.googleEventId, calSig: t.calSig, calAt: t.calAt };
    Object.keys(t).forEach(function (k) { delete t[k]; });
    Object.assign(t, keep);
  }

  async function deleteTask(id) {
    var task = state.tasks.find(function (t) { return t.id === id && !t.deleted; });
    if (!task) return;
    var ok = await confirmDialog('Delete task?', 'Delete "' + task.taskName + '"? This cannot be undone.');
    if (!ok) return;
    tombstoneTask(task, Date.now());
    closeOverlay('taskOverlay');
    commit();
    toast('Task deleted');
  }

  // ---------- Lists ----------
  function renderListManager() {
    var lists = liveLists();
    $('listManager').innerHTML = lists.map(function (l) {
      var count = liveTasks().filter(function (t) { return t.listId === l.id; }).length;
      return '<li data-id="' + esc(l.id) + '">' +
        '<input type="text" value="' + esc(l.name) + '" maxlength="80" data-action="rename" aria-label="List name" />' +
        '<span class="list-count">' + plural(count, 'task') + '</span>' +
        '<button type="button" class="btn btn-danger-outline btn-sm" data-action="delete-list"' + (lists.length === 1 ? ' disabled title="Keep at least one list"' : '') + '>Delete</button>' +
        '</li>';
    }).join('');
  }

  async function deleteList(id) {
    var l = findList(id);
    if (!l || l.deleted || liveLists().length === 1) return;
    var tasks = liveTasks().filter(function (t) { return t.listId === id; });
    var msg = tasks.length
      ? 'Delete the list "' + l.name + '" and its ' + plural(tasks.length, 'task') + '? This cannot be undone.'
      : 'Delete the list "' + l.name + '"?';
    $('listsOverlay').hidden = true;
    var ok = await confirmDialog('Delete list?', msg);
    $('listsOverlay').hidden = false;
    if (!ok) return;
    var now = Date.now();
    tasks.forEach(function (t) { tombstoneTask(t, now); });
    l.deleted = true;
    l.updatedAt = now;
    renderListManager();
    commit();
  }

  // ---------- Merge ----------
  function mergeRecords(localArr, remoteArr, isTask) {
    var map = new Map();
    localArr.forEach(function (r) { map.set(r.id, r); });
    remoteArr.forEach(function (r) {
      var l = map.get(r.id);
      if (!l) { map.set(r.id, Object.assign({}, r)); return; }
      var content = (r.updatedAt || 0) > (l.updatedAt || 0) ? r : l;
      var merged = Object.assign({}, content);
      if (isTask) {
        var cal = (r.calAt || 0) > (l.calAt || 0) ? r : l;
        merged.googleEventId = cal.googleEventId || null;
        merged.calSig = cal.calSig || null;
        merged.calAt = cal.calAt || 0;
      }
      map.set(r.id, merged);
    });
    return Array.from(map.values());
  }

  function mergeRemote(remote) {
    var r = normalise(remote);
    state.lists = mergeRecords(state.lists, r.lists, false);
    state.tasks = mergeRecords(state.tasks, r.tasks, true);
    if ((r.shared.updatedAt || 0) > (state.shared.updatedAt || 0)) state.shared = r.shared;
    tidyLists();
  }

  // A brand-new device starts with an empty "Personal" list; drop it once real lists arrive.
  function tidyLists() {
    var now = Date.now();
    var lists = liveLists();
    var real = lists.filter(function (l) { return !l.seed; });
    if (real.length) {
      lists.forEach(function (l) {
        if (l.seed && !liveTasks().some(function (t) { return t.listId === l.id; })) { l.deleted = true; l.updatedAt = now; }
      });
    }
    if (!liveLists().length) state.lists.push(seedList());
  }

  function purgeTombstones() {
    var cutoff = Date.now() - TOMBSTONE_TTL;
    state.tasks = state.tasks.filter(function (t) { return !(t.deleted && !t.googleEventId && t.updatedAt < cutoff); });
    state.lists = state.lists.filter(function (l) { return !(l.deleted && l.updatedAt < cutoff); });
  }

  // ---------- Google sign-in ----------
  var gToken = null;
  var gTokenExp = 0;

  function tokenValid() { return !!gToken && Date.now() < gTokenExp - 60000; }

  function loadGis() {
    return new Promise(function (resolve, reject) {
      if (window.google && window.google.accounts && window.google.accounts.oauth2) return resolve();
      var s = document.createElement('script');
      s.src = 'https://accounts.google.com/gsi/client';
      s.async = true;
      s.onload = function () { resolve(); };
      s.onerror = function () { reject(new Error('Could not load Google sign-in. Check your internet connection.')); };
      document.head.appendChild(s);
    });
  }

  // Must be called from a tap/click so the Google sign-in popup is allowed.
  async function requestToken(forceConsent) {
    var clientId = (state.settings.googleClientId || '').trim();
    if (!clientId) throw new Error('Enter your Google OAuth Client ID in Settings first.');
    await loadGis();
    return new Promise(function (resolve, reject) {
      var oauth = window.google.accounts.oauth2;
      var client = oauth.initTokenClient({
        client_id: clientId,
        scope: CAL_SCOPE + ' ' + DRIVE_SCOPE,
        callback: function (r) {
          if (r.error) return reject(new Error(r.error_description || r.error));
          if (oauth.hasGrantedAllScopes && !oauth.hasGrantedAllScopes(r, CAL_SCOPE, DRIVE_SCOPE)) {
            return reject(new Error('Please tick both permissions (Calendar and app data) when Google asks, then try again.'));
          }
          gToken = r.access_token;
          gTokenExp = Date.now() + Number(r.expires_in || 3600) * 1000;
          resolve(gToken);
        },
        error_callback: function (e) {
          reject(new Error(e && e.type === 'popup_closed' ? 'Google sign-in was closed.' : 'Google sign-in failed' + (e && e.message ? ': ' + e.message : '.')));
        }
      });
      client.requestAccessToken({ prompt: forceConsent ? 'consent' : '' });
    });
  }

  function AuthExpired() { this.message = 'Google session expired'; }

  async function gFetch(url, opts, okStatuses) {
    opts = opts || {};
    opts.headers = Object.assign({ Authorization: 'Bearer ' + gToken }, opts.headers || {});
    var res = await fetch(url, opts);
    if (res.status === 401) { gToken = null; throw new AuthExpired(); }
    if (okStatuses && okStatuses.indexOf(res.status) !== -1) return { status: res.status, data: null };
    if (!res.ok) {
      var detail = '';
      try { var j = await res.json(); detail = j.error && j.error.message ? j.error.message : ''; } catch (e) { /* ignore */ }
      var err = new Error('Google error ' + res.status + (detail ? ': ' + detail : ''));
      err.status = res.status;
      throw err;
    }
    if (res.status === 204) return { status: 204, data: null };
    var text = await res.text();
    return { status: res.status, data: text ? JSON.parse(text) : null };
  }

  // ---------- Drive (device sync) ----------
  async function driveListFiles() {
    var q = encodeURIComponent("name='" + DATA_FILE + "' and trashed=false");
    var r = await gFetch(DRIVE_API + '/files?spaces=appDataFolder&pageSize=10&orderBy=createdTime&fields=files(id)&q=' + q);
    return (r.data && r.data.files || []).map(function (f) { return f.id; });
  }

  async function driveRead(id) {
    var r = await gFetch(DRIVE_API + '/files/' + encodeURIComponent(id) + '?alt=media', {}, [404]);
    return r.status === 404 ? null : r.data;
  }

  function payload() {
    return JSON.stringify({ app: 'personal-organiser', format: 2, savedAt: Date.now(), lists: state.lists, tasks: state.tasks, shared: state.shared });
  }

  async function driveWrite(id) {
    if (id) {
      var r = await gFetch(DRIVE_UPLOAD + '/files/' + encodeURIComponent(id) + '?uploadType=media',
        { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: payload() }, [404]);
      if (r.status !== 404) return id;
    }
    var boundary = 'po' + uid();
    var body = '--' + boundary + '\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n' +
      JSON.stringify({ name: DATA_FILE, parents: ['appDataFolder'] }) +
      '\r\n--' + boundary + '\r\nContent-Type: application/json\r\n\r\n' + payload() + '\r\n--' + boundary + '--';
    var c = await gFetch(DRIVE_UPLOAD + '/files?uploadType=multipart&fields=id',
      { method: 'POST', headers: { 'Content-Type': 'multipart/related; boundary=' + boundary }, body: body });
    return c.data.id;
  }

  // ---------- Calendar ----------
  function eventBody(t) {
    var start = nextOccurrence(t, new Date());
    var end = new Date(start.getTime() + 30 * 60000);
    var tz = timeZone();
    var desc = (t.description ? t.description + '\n\n' : '') +
      'Personal Organiser - ' + formatSchedule(t) + ' - priority ' + t.priority + ', status ' + String(t.status).replace('_', ' ');
    return {
      summary: eventTitle(t),
      description: desc,
      start: { dateTime: localDateTime(start), timeZone: tz },
      end: { dateTime: localDateTime(end), timeZone: tz },
      recurrence: [buildRRule(t)],
      reminders: { useDefault: false, overrides: [{ method: 'popup', minutes: Number(state.shared.reminderMinutes) || 0 }] }
    };
  }

  function calJson(method, path, body, ok) {
    return gFetch(CAL_API + path, { method: method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }, ok);
  }

  async function calendarTask(t) {
    var now = Date.now();
    if (t.deleted) {
      await calJson('DELETE', '/calendars/primary/events/' + encodeURIComponent(t.googleEventId), null, [404, 410]);
      t.googleEventId = null; t.calSig = null; t.calAt = now;
      return;
    }
    var body = eventBody(t);
    var sig = calSig(t);
    if (t.googleEventId) {
      var r = await calJson('PUT', '/calendars/primary/events/' + encodeURIComponent(t.googleEventId), body, [404, 410]);
      if (r.status !== 404 && r.status !== 410) { t.calSig = sig; t.calAt = now; return; }
    }
    var created = await calJson('POST', '/calendars/primary/events', body);
    t.googleEventId = created.data.id; t.calSig = sig; t.calAt = now;
  }

  function calendarWork() {
    return state.tasks.filter(function (t) { return t.deleted ? !!t.googleEventId : !calendarUpToDate(t); });
  }

  async function calendarPass() {
    var failures = 0;
    var work = calendarWork();
    for (var i = 0; i < work.length; i++) {
      try { await calendarTask(work[i]); } catch (e) {
        if (e instanceof AuthExpired) throw e;
        failures++;
        console.error('Calendar update failed for', work[i].taskName || work[i].id, e);
      }
    }
    return failures;
  }

  // ---------- Sync orchestration ----------
  var syncing = false;
  var syncQueued = false;
  var syncTimer = null;
  var lastSyncError = '';

  function pendingChanges() {
    var since = state.settings.lastSyncAt || 0;
    var n = 0;
    state.tasks.forEach(function (t) { if ((t.updatedAt || 0) > since) n++; });
    state.lists.forEach(function (l) { if ((l.updatedAt || 0) > since) n++; });
    if ((state.shared.updatedAt || 0) > since) n++;
    return n;
  }

  async function syncNow() {
    if (syncing) { syncQueued = true; return; }
    syncing = true;
    renderSyncStatus();
    var started = Date.now();
    var calFailures = 0;
    try {
      var ids = await driveListFiles();
      for (var i = 0; i < ids.length; i++) {
        var remote = await driveRead(ids[i]);
        if (remote && Array.isArray(remote.tasks)) mergeRemote(remote);
      }
      save();
      render();
      calFailures = await calendarPass();
      purgeTombstones();
      save();
      var keep = await driveWrite(ids[0] || state.settings.driveFileId);
      // Two devices may have created the file at the same moment: keep one.
      for (var j = 0; j < ids.length; j++) {
        if (ids[j] !== keep) await gFetch(DRIVE_API + '/files/' + encodeURIComponent(ids[j]), { method: 'DELETE' }, [404]);
      }
      state.settings.driveFileId = keep;
      state.settings.lastSyncAt = started;
      lastSyncError = calFailures ? plural(calFailures, 'calendar event') + ' could not be updated; will retry.' : '';
      save();
    } finally {
      syncing = false;
      render();
      if (syncQueued) { syncQueued = false; scheduleSync(); }
    }
  }

  function backgroundSync() {
    if (!state.settings.connected || !tokenValid() || !navigator.onLine) { renderSyncStatus(); return; }
    syncNow().catch(function (e) {
      lastSyncError = e instanceof AuthExpired ? '' : e.message;
      console.error('Sync failed', e);
      renderSyncStatus();
    });
  }

  function scheduleSync() {
    clearTimeout(syncTimer);
    syncTimer = setTimeout(backgroundSync, 1500);
  }

  // From a tap: sign in if needed, then sync.
  async function interactiveSync(forceConsent) {
    try {
      if (!tokenValid() || forceConsent) await requestToken(forceConsent);
      state.settings.connected = true;
      save();
      await syncNow();
      toast(lastSyncError ? lastSyncError : 'Everything is in sync', !!lastSyncError);
    } catch (e) {
      lastSyncError = e instanceof AuthExpired ? '' : e.message;
      toast(e instanceof AuthExpired ? 'Google sign-in expired. Tap "Sync now" again.' : e.message, true);
    }
    render();
    renderSettings();
  }

  function renderSyncStatus() {
    var pill = $('syncPill');
    var banner = $('syncBanner');
    if (!state.settings.connected) { pill.hidden = true; banner.hidden = true; return; }
    pill.hidden = false;
    pill.classList.remove('warn');
    var last = state.settings.lastSyncAt;
    if (syncing) {
      pill.textContent = 'Syncing...';
    } else if (lastSyncError) {
      pill.textContent = 'Sync problem';
      pill.classList.add('warn');
    } else {
      pill.textContent = last ? 'Synced ' + clock(last) : 'Not synced yet';
    }
    var needsSignIn = !tokenValid() && !syncing;
    if (needsSignIn) {
      var n = pendingChanges();
      banner.hidden = false;
      $('syncBannerText').textContent = (n ? plural(n, 'change') + ' not sent yet. ' : '') +
        'Tap Sync now to get the latest from your other devices' + (n ? ' and send yours.' : '.');
      if (!navigator.onLine) $('syncBannerText').textContent = 'You are offline. Changes are saved on this device and will sync when you are back online.';
    } else if (lastSyncError && !syncing) {
      banner.hidden = false;
      $('syncBannerText').textContent = lastSyncError;
    } else {
      banner.hidden = true;
    }
  }

  async function disconnectGoogle() {
    var ok = await confirmDialog('Disconnect Google on this device?',
      'This device will stop syncing. Your tasks stay here, and your other devices and calendar events are not changed. You can reconnect later.', 'Disconnect');
    if (!ok) return;
    if (gToken && window.google && window.google.accounts) {
      try { window.google.accounts.oauth2.revoke(gToken, function () {}); } catch (e) { /* ignore */ }
    }
    gToken = null;
    lastSyncError = '';
    state.settings.connected = false;
    save();
    render();
    renderSettings();
    toast('Google disconnected on this device');
  }

  // ---------- Notifications ----------
  var swReg = null;

  function notifSupported() { return 'Notification' in window; }

  async function showNotification(title, body, tag) {
    if (!notifSupported() || Notification.permission !== 'granted') return false;
    var opts = { body: body, tag: tag, icon: 'icons/icon-192.png', badge: 'icons/icon-192.png' };
    try {
      if (swReg && swReg.showNotification) { await swReg.showNotification(title, opts); return true; }
      new Notification(title, opts);
      return true;
    } catch (e) {
      console.error('Notification failed', e);
      return false;
    }
  }

  function loadFired() {
    try { return JSON.parse(localStorage.getItem(FIRED_KEY)) || {}; } catch (e) { return {}; }
  }

  function checkReminders() {
    var now = new Date();
    var lead = Number(state.shared.reminderMinutes) || 0;
    var target = new Date(now.getTime() + lead * 60000);
    var hhmm = pad(target.getHours()) + ':' + pad(target.getMinutes());
    var fired = loadFired();
    var today = localDateKey(now);
    var changed = false;
    Object.keys(fired).forEach(function (k) { if (fired[k] !== today) { delete fired[k]; changed = true; } });
    liveTasks().forEach(function (t) {
      if (t.status === 'completed' || t.scheduleTime !== hhmm || !occursOn(t, target)) return;
      // Tasks already in Google Calendar are reminded by Calendar itself; avoid double pop-ups.
      if (state.settings.connected && calendarUpToDate(t)) return;
      var key = t.id + '@' + localDateKey(target) + 'T' + hhmm;
      if (fired[key]) return;
      fired[key] = today;
      changed = true;
      var when = lead ? 'In ' + lead + ' min (' + t.scheduleTime + ')' : 'Now (' + t.scheduleTime + ')';
      showNotification(t.taskName, when + (t.description ? ' - ' + t.description : ''), key).then(function (shown) {
        if (!shown) toast('Reminder: ' + t.taskName + ' at ' + t.scheduleTime);
      });
    });
    if (changed) localStorage.setItem(FIRED_KEY, JSON.stringify(fired));
  }

  // ---------- Settings ----------
  function isStandalone() {
    return window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
  }

  function renderSettings() {
    var ns = $('notifStatus');
    var isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent);
    if (!notifSupported()) {
      ns.textContent = isIOS && !isStandalone()
        ? 'On iPhone, add this app to your Home Screen (Share > Add to Home Screen) and open it from there to allow reminders.'
        : 'This browser does not support pop-up reminders.';
      $('enableNotifBtn').disabled = true;
      $('testNotifBtn').disabled = true;
    } else {
      var p = Notification.permission;
      ns.textContent = p === 'granted' ? 'Pop-up reminders are allowed on this device.'
        : p === 'denied' ? 'Reminders are blocked. Allow notifications for this app in your device or browser settings.'
        : 'Pop-up reminders are not enabled yet.';
      $('enableNotifBtn').disabled = p !== 'default';
      $('testNotifBtn').disabled = p !== 'granted';
    }
    $('sReminderMinutes').value = String(state.shared.reminderMinutes || 0);
    $('sClientId').value = state.settings.googleClientId || '';
    var gs = $('gcalStatus');
    var connected = state.settings.connected;
    if (!connected) {
      gs.textContent = 'Not connected on this device.';
    } else {
      var last = state.settings.lastSyncAt;
      gs.textContent = 'Connected. ' + (last ? 'Last synced ' + new Date(last).toLocaleString() + '.' : 'Not synced yet.') +
        (lastSyncError ? ' ' + lastSyncError : '');
    }
    $('gcalDisconnectBtn').hidden = !connected;
    $('gcalConnectBtn').hidden = connected;
    $('gcalSyncBtn').hidden = !connected;
  }

  function exportBackup() {
    var data = { version: 2, lists: liveLists(), tasks: liveTasks(), shared: state.shared };
    var blob = new Blob([JSON.stringify({ app: 'personal-organiser', exportedAt: new Date().toISOString(), data: data }, null, 2)], { type: 'application/json' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'personal-organiser-backup-' + localDateKey(new Date()) + '.json';
    document.body.appendChild(a);
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  }

  async function importBackup(file) {
    var text = await file.text();
    var parsed;
    try { parsed = JSON.parse(text); } catch (e) { toast('That file is not a valid backup.', true); return; }
    var d = parsed && parsed.data ? parsed.data : parsed;
    if (!d || !Array.isArray(d.tasks) || !Array.isArray(d.lists) || !live(d.lists).length) { toast('That file is not a Personal Organiser backup.', true); return; }
    var incoming = normalise(d);
    var inTasks = live(incoming.tasks);
    var msg = 'Importing replaces the ' + plural(liveTasks().length, 'task') + ' here with ' + plural(inTasks.length, 'task') + ' from the backup.' +
      (state.settings.connected ? ' Your other synced devices will be updated too.' : '');
    var ok = await confirmDialog('Replace all tasks?', msg, 'Import');
    if (!ok) return;
    var now = Date.now();
    var inListIds = new Set(live(incoming.lists).map(function (l) { return l.id; }));
    var inTaskIds = new Set(inTasks.map(function (t) { return t.id; }));
    liveTasks().forEach(function (t) { if (!inTaskIds.has(t.id)) tombstoneTask(t, now); });
    liveLists().forEach(function (l) { if (!inListIds.has(l.id)) { l.deleted = true; l.updatedAt = now; } });
    var listMap = new Map(state.lists.map(function (l) { return [l.id, l]; }));
    live(incoming.lists).forEach(function (l) {
      var rec = { id: l.id, name: l.name, seed: false, deleted: false, updatedAt: now };
      if (listMap.has(l.id)) Object.assign(listMap.get(l.id), rec); else state.lists.push(rec);
    });
    var taskMap = new Map(state.tasks.map(function (t) { return [t.id, t]; }));
    inTasks.forEach(function (t) {
      var existing = taskMap.get(t.id);
      // Keep any known calendar event so it is updated rather than duplicated.
      var rec = Object.assign({}, t, {
        deleted: false, updatedAt: now,
        googleEventId: (existing && existing.googleEventId) || t.googleEventId || null,
        calSig: null, calAt: now
      });
      if (existing) { Object.keys(existing).forEach(function (k) { delete existing[k]; }); Object.assign(existing, rec); }
      else state.tasks.push(rec);
    });
    state.shared = { reminderMinutes: Number(incoming.shared.reminderMinutes) || 0, updatedAt: now };
    tidyLists();
    ui.listFilter = 'all';
    commit();
    renderSettings();
    toast('Backup imported');
  }

  // ---------- Events ----------
  function bindDialogAccessibility() {
    var overlays = Array.from(document.querySelectorAll('.overlay'));
    var returnFocus = {};
    function topDialog() {
      if (!$('confirmOverlay').hidden) return $('confirmOverlay');
      return overlays.filter(function (o) { return !o.hidden; }).pop();
    }
    overlays.forEach(function (overlay) {
      new MutationObserver(function () {
        var top = topDialog();
        document.body.classList.toggle('modal-open', !!top);
        if (!overlay.hidden) {
          returnFocus[overlay.id] = document.activeElement;
          var first = overlay.id === 'confirmOverlay' ? $('confirmCancel') : overlay.querySelector('button, input');
          if (first) first.focus({ preventScroll: true });
        } else {
          var previous = returnFocus[overlay.id];
          if (previous && previous.isConnected && previous.getClientRects().length) previous.focus({ preventScroll: true });
        }
      }).observe(overlay, { attributes: true, attributeFilter: ['hidden'] });
    });
    document.addEventListener('keydown', function (e) {
      if (e.key !== 'Tab') return;
      var top = topDialog();
      if (!top) return;
      var controls = Array.from(top.querySelectorAll('button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href]'))
        .filter(function (el) { return el.getClientRects().length > 0; });
      if (!controls.length) return;
      var first = controls[0], last = controls[controls.length - 1];
      if (!top.contains(document.activeElement) || (e.shiftKey && document.activeElement === first)) {
        e.preventDefault();
        (e.shiftKey ? last : first).focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    });
  }

  function bind() {
    bindDialogAccessibility();
    document.querySelectorAll('[data-view]').forEach(function (b) {
      b.addEventListener('click', function () {
        ui.view = b.getAttribute('data-view');
        try { localStorage.setItem('personalOrganiser.view', ui.view); } catch (e) { /* preference is optional */ }
        render();
      });
    });
    $('newTaskBtn').addEventListener('click', function () { openTaskModal(null, ui.view === 'tasks' ? ui.tab : 'daily'); });
    $('addDayTaskBtn').addEventListener('click', addTaskForDay);
    function moveMonth(offset) {
      ui.month = new Date(ui.month.getFullYear(), ui.month.getMonth() + offset, 1);
      ui.selectedDate = localDateKey(ui.month);
      renderCalendar();
    }
    $('prevMonthBtn').addEventListener('click', function () { moveMonth(-1); });
    $('nextMonthBtn').addEventListener('click', function () { moveMonth(1); });
    $('todayBtn').addEventListener('click', function () {
      var today = new Date();
      ui.month = new Date(today.getFullYear(), today.getMonth(), 1);
      ui.selectedDate = localDateKey(today);
      renderCalendar();
    });
    $('calendarView').addEventListener('click', function (e) {
      var taskButton = e.target.closest('[data-edit-task]');
      if (taskButton) {
        var task = liveTasks().find(function (t) { return t.id === taskButton.getAttribute('data-edit-task'); });
        if (task) openTaskModal(task);
        return;
      }
      var dayButton = e.target.closest('[data-date]');
      if (!dayButton) return;
      ui.selectedDate = dayButton.getAttribute('data-date');
      var selected = dateFromKey(ui.selectedDate);
      ui.month = new Date(selected.getFullYear(), selected.getMonth(), 1);
      renderCalendar();
      var newButton = $('calendarGrid').querySelector('[data-date="' + ui.selectedDate + '"]');
      if (newButton) newButton.focus({ preventScroll: true });
      if (dayButton.hasAttribute('data-show-agenda') || window.matchMedia('(max-width: 767px)').matches) {
        $('agendaTitle').scrollIntoView({ behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' });
      }
    });
    $('columns').addEventListener('keydown', function (e) {
      if ((e.key === 'Enter' || e.key === ' ') && e.target.classList.contains('task')) {
        e.preventDefault();
        var task = liveTasks().find(function (t) { return t.id === e.target.getAttribute('data-id'); });
        if (task) openTaskModal(task);
      }
    });
    $('columns').addEventListener('click', function (e) {
      var btn = e.target.closest('[data-action]');
      if (btn) {
        var action = btn.getAttribute('data-action');
        if (action === 'add') return openTaskModal(null, btn.getAttribute('data-type'));
        var id = btn.getAttribute('data-id');
        if (action === 'edit') return openTaskModal(state.tasks.find(function (t) { return t.id === id; }));
        if (action === 'delete') return deleteTask(id);
      }
      var card = e.target.closest('.task');
      if (card) openTaskModal(state.tasks.find(function (t) { return t.id === card.getAttribute('data-id'); }));
    });

    $('mobileTabs').addEventListener('click', function (e) {
      var b = e.target.closest('button[data-tab]');
      if (!b) return;
      ui.tab = b.getAttribute('data-tab');
      render();
    });

    $('listFilter').addEventListener('change', function (e) { ui.listFilter = e.target.value; render(); });
    $('fScheduleType').addEventListener('change', updateScheduleFields);
    $('taskForm').addEventListener('submit', submitTask);
    $('deleteTaskBtn').addEventListener('click', function () { if (ui.editingId) deleteTask(ui.editingId); });

    document.querySelectorAll('[data-close]').forEach(function (b) {
      b.addEventListener('click', function () { closeOverlay(b.getAttribute('data-close')); });
    });
    document.addEventListener('keydown', function (e) {
      if (e.key !== 'Escape' || !$('confirmOverlay').hidden) return;
      ['taskOverlay', 'listsOverlay', 'settingsOverlay'].some(function (id) {
        if (!$(id).hidden) { closeOverlay(id); return true; }
        return false;
      });
    });

    // Lists
    $('manageListsBtn').addEventListener('click', function () { renderListManager(); $('listsOverlay').hidden = false; });
    $('addListForm').addEventListener('submit', function (e) {
      e.preventDefault();
      var name = $('newListName').value.trim();
      if (!name) return;
      state.lists.push({ id: uid(), name: name, seed: false, deleted: false, updatedAt: Date.now() });
      $('newListName').value = '';
      renderListManager();
      commit();
    });
    $('listManager').addEventListener('change', function (e) {
      if (e.target.getAttribute('data-action') !== 'rename') return;
      var l = findList(e.target.closest('li').getAttribute('data-id'));
      var name = e.target.value.trim();
      if (!l) return;
      if (!name) { e.target.value = l.name; return; }
      l.name = name;
      l.seed = false;
      l.updatedAt = Date.now();
      commit();
    });
    $('listManager').addEventListener('click', function (e) {
      var b = e.target.closest('[data-action="delete-list"]');
      if (b) deleteList(b.closest('li').getAttribute('data-id'));
    });

    // Settings
    $('settingsBtn').addEventListener('click', function () { renderSettings(); $('settingsOverlay').hidden = false; });
    $('enableNotifBtn').addEventListener('click', async function () {
      try { await Notification.requestPermission(); } catch (e) { /* older Safari uses callback form */ }
      renderSettings();
      if (Notification.permission === 'granted') toast('Reminders enabled');
    });
    $('testNotifBtn').addEventListener('click', async function () {
      var ok = await showNotification('Test reminder', 'Pop-up reminders are working.', 'test');
      if (!ok) toast('Could not show a notification on this device.', true);
    });
    $('sReminderMinutes').addEventListener('change', function (e) {
      state.shared = { reminderMinutes: Number(e.target.value), updatedAt: Date.now() };
      commit();
      renderSettings();
    });
    $('sClientId').addEventListener('change', function (e) {
      state.settings.googleClientId = e.target.value.trim();
      save();
    });
    $('gcalConnectBtn').addEventListener('click', function () {
      state.settings.googleClientId = $('sClientId').value.trim();
      save();
      interactiveSync(true);
    });
    $('gcalSyncBtn').addEventListener('click', function () { interactiveSync(false); });
    $('syncNowBannerBtn').addEventListener('click', function () { interactiveSync(false); });
    $('gcalDisconnectBtn').addEventListener('click', disconnectGoogle);
    function toggleClientIdHelp(open) {
      $('clientIdInfo').hidden = !open;
      $('clientIdInfoBtn').setAttribute('aria-expanded', String(open));
    }
    $('originText').textContent = location.origin;
    $('clientIdInfoBtn').addEventListener('click', function () { toggleClientIdHelp($('clientIdInfo').hidden); });
    $('clientIdInfoClose').addEventListener('click', function () { toggleClientIdHelp(false); });
    $('copyOriginBtn').addEventListener('click', async function () {
      try { await navigator.clipboard.writeText(location.origin); toast('Address copied'); }
      catch (e) { toast('Copy failed - select the address and copy it manually.', true); }
    });
    $('exportBtn').addEventListener('click', exportBackup);
    $('importInput').addEventListener('change', function (e) {
      var file = e.target.files && e.target.files[0];
      e.target.value = '';
      if (file) importBackup(file);
    });

    window.addEventListener('online', function () { renderSyncStatus(); backgroundSync(); });
    window.addEventListener('offline', renderSyncStatus);
    // Another tab of this app on the same device saved changes.
    window.addEventListener('storage', function (e) {
      if (e.key === STORE_KEY) { state = loadState(); render(); }
    });
    document.addEventListener('visibilitychange', function () {
      if (document.hidden) return;
      checkReminders();
      backgroundSync();
      renderSyncStatus();
    });
  }

  // ---------- Init ----------
  function init() {
    fillSelectors();
    bind();
    save();
    render();
    if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1')) {
      navigator.serviceWorker.register('sw.js').then(function (reg) { swReg = reg; }).catch(function (e) {
        console.warn('Offline mode unavailable', e);
      });
    }
    checkReminders();
    setInterval(checkReminders, 20000);
    // Pick up changes from other devices while the app is open.
    setInterval(function () { if (!document.hidden) backgroundSync(); }, 60000);
  }

  init();
})();
