'use strict';

// Тексты интерфейса. Все данные о блюдах, продуктах и нормах берутся из menu.json.
const DAYS = ['Понедельник', 'Вторник', 'Среда', 'Четверг', 'Пятница', 'Суббота', 'Воскресенье'];
const DAYS_SHORT = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'];
const MEAL_NAMES = { breakfast: 'Завтрак', lunch: 'Обед', dinner: 'Ужин' };
// Куда ложится вторая половина при 4 порциях (на следующий день).
const LEFTOVER_TARGET = { breakfast: 'breakfast', lunch: 'lunch', dinner: 'lunch' };
const STORAGE_KEY = 'menu-planner-week-v1';

let DATA, PEOPLE, MEALS, TOTAL_KCAL, DISHES;
let state = { cells: {} };
const ui = { open: new Set() };

const $ = (sel) => document.querySelector(sel);
const key = (d, m) => `${d}-${m}`;
const parseKey = (k) => { const [d, m] = k.split('-'); return [Number(d), m]; };
const peek = (k) => state.cells[k] || {};
const cell = (k) => (state.cells[k] ||= {});
const label = (k) => { const [d, m] = parseKey(k); return `${DAYS_SHORT[d]}, ${MEAL_NAMES[m].toLowerCase()}`; };
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const r0 = (x) => Math.round(x);
const lines = (s) => String(s || '').split('\n').map((x) => x.trim()).filter(Boolean);

// ---------- загрузка и сохранение ----------

async function init() {
  try {
    const res = await fetch('menu.json', { cache: 'no-cache' });
    if (!res.ok) throw new Error(res.status);
    DATA = await res.json();
  } catch (e) {
    const err = $('#error');
    err.hidden = false;
    err.textContent = 'Не получилось загрузить menu.json. Если вы открыли файл index.html двойным щелчком — откройте сайт через ссылку или локальный сервер (см. README). Если меняли menu.json — проверьте, что в нём нет ошибки (лишней или пропущенной запятой).';
    return;
  }
  PEOPLE = DATA.people;
  MEALS = Object.keys(DATA.meal_split);
  TOTAL_KCAL = PEOPLE.reduce((s, p) => s + p.kcal_target, 0);
  DISHES = Object.fromEntries(DATA.dishes.map((d) => [d.id, d]));

  load();
  bindEvents();
  renderAll();
}

function load() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY));
    if (saved && saved.cells) state = saved;
  } catch (e) { /* нет доступа к хранилищу — начинаем с пустой недели */ }
  // Если блюдо удалили из menu.json — убираем его из плана.
  for (const c of Object.values(state.cells)) {
    if (c.dish && !DISHES[c.dish]) { delete c.dish; delete c.portions; delete c.optOff; }
  }
}

function save() {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch (e) { /* ignore */ }
}

// ---------- расчёты ----------

function share(person, who) {
  if (who === 'both') return person.kcal_target / TOTAL_KCAL;
  return who === person.id ? 1 : 0;
}

function activeIngredients(dish, optOff = []) {
  return dish.ingredients.filter((i) => !(i.optional && optOff.includes(i.ingredient)));
}

// КБЖУ одной порции каждого человека (одна готовка = по порции на каждого).
function nutrition(dish, optOff) {
  const res = {};
  for (const p of PEOPLE) res[p.id] = { kcal: 0, protein: 0, fat: 0, carbs: 0 };
  for (const i of activeIngredients(dish, optOff)) {
    const info = DATA.ingredients[i.ingredient];
    if (!info) continue;
    for (const p of PEOPLE) {
      const s = share(p, i.who) * i.grams / 100;
      for (const k of Object.keys(res[p.id])) res[p.id][k] += (info[k] || 0) * s;
    }
  }
  return res;
}

function leftoverTarget(d, m) {
  return d >= DAYS.length - 1 ? null : key(d + 1, LEFTOVER_TARGET[m]);
}

// Что фактически стоит в каждой ячейке: своя готовка, остатки или пусто.
function computeWeek() {
  const leftovers = {};
  const sundayWarn = {};
  DAYS.forEach((_, d) => MEALS.forEach((m) => {
    const k = key(d, m), c = peek(k);
    if (!c.dish || c.portions !== 4) return;
    const t = leftoverTarget(d, m);
    if (t) leftovers[t] = { type: 'leftover', from: k, dish: c.dish, optOff: c.optOff || [] };
    else sundayWarn[k] = true;
  }));
  const eff = {};
  DAYS.forEach((_, d) => MEALS.forEach((m) => {
    const k = key(d, m), c = peek(k);
    if (leftovers[k]) eff[k] = leftovers[k];
    else if (c.dish) eff[k] = { type: 'cook', dish: c.dish, portions: c.portions, optOff: c.optOff || [] };
    else eff[k] = { type: 'empty' };
  }));
  return { eff, sundayWarn };
}

// ---------- изменения плана ----------

function setDish(k, dishId) {
  const c = cell(k);
  if (!dishId) { delete c.dish; delete c.portions; delete c.optOff; }
  else {
    c.dish = dishId;
    c.portions = DISHES[dishId].default_portions === 4 ? 4 : 2;
    c.optOff = [];
    if (c.portions === 4) makeRoomForLeftovers(k);
  }
  commit();
}

function setPortions(k, n) {
  cell(k).portions = n;
  if (n === 4) makeRoomForLeftovers(k);
  commit();
}

// Проверяем, свободно ли место для остатков; если нет — спрашиваем, что делать.
function makeRoomForLeftovers(k) {
  const [d, m] = parseKey(k);
  const t = leftoverTarget(d, m);
  if (!t) return; // воскресенье — переносить некуда, покажем предупреждение в ячейке
  const c = peek(k);
  const name = DISHES[c.dish].name;
  const [td, tm] = parseKey(t);
  const problems = [];
  const fixes = [];

  const tc = peek(t);
  if (tc.dish) {
    problems.push(`в ячейке «${label(t)}» уже выбрано «${DISHES[tc.dish].name}»`);
    fixes.push(() => { const x = cell(t); delete x.dish; delete x.portions; delete x.optOff; });
  }
  MEALS.forEach((sm) => {
    const s = key(d, sm);
    if (s === k) return;
    const sc = peek(s);
    if (sc.dish && sc.portions === 4 && leftoverTarget(d, sm) === t) {
      problems.push(`туда уже ложатся остатки «${DISHES[sc.dish].name}» (${label(s)})`);
      fixes.push(() => { cell(s).portions = 2; });
    }
  });
  // То же блюдо в другом приёме пищи того дня.
  const { eff } = computeWeek();
  MEALS.forEach((om) => {
    if (om === tm) return;
    const ok = key(td, om), e = eff[ok];
    if (e.type === 'empty' || e.dish !== c.dish) return;
    problems.push(`«${name}» уже стоит в ячейке «${label(ok)}» — одно блюдо можно есть один раз в день`);
    if (e.type === 'cook') fixes.push(() => { const x = cell(ok); delete x.dish; delete x.portions; delete x.optOff; });
    else fixes.push(() => { cell(e.from).portions = 2; });
  });

  if (!problems.length) return;
  const ok = confirm(
    `Остатки «${name}» должны лечь на «${label(t)}», но:\n\n• ${problems.join('\n• ')}\n\n` +
    'ОК — освободить место для остатков.\nОтмена — оставить 2 порции.'
  );
  if (ok) fixes.forEach((f) => f());
  else cell(k).portions = 2;
}

function commit() {
  save();
  renderAll();
}

// ---------- отображение: план ----------

function renderAll() {
  renderPlan();
  renderResults();
}

function renderResults() {
  renderShopping();
  renderMenu();
}

function renderPlan() {
  const { eff, sundayWarn } = computeWeek();
  $('#plan').innerHTML = DAYS.map((dayName, d) => `
    <section class="day">
      <h2>${dayName}</h2>
      ${MEALS.map((m) => renderMeal(d, m, eff, sundayWarn)).join('')}
      ${renderTotals(d, eff)}
    </section>`).join('');
}

function kcalLine(dish, optOff) {
  const n = nutrition(dish, optOff);
  return `<div class="kcal">${PEOPLE.map((p) =>
    `<span>${esc(p.name)}: <b>${r0(n[p.id].kcal)} ккал</b> · белок ${r0(n[p.id].protein)} г</span>`).join('')}</div>`;
}

function dishOptions(d, m, selected, eff) {
  const usedElsewhere = new Set(MEALS.filter((om) => om !== m)
    .map((om) => eff[key(d, om)]).filter((e) => e.type !== 'empty').map((e) => e.dish));
  const opt = (dish) => {
    const blocked = usedElsewhere.has(dish.id) && dish.id !== selected;
    return `<option value="${esc(dish.id)}" ${dish.id === selected ? 'selected' : ''} ${blocked ? 'disabled' : ''}>${esc(dish.name)}${blocked ? ' — уже в этот день' : ''}</option>`;
  };
  const fit = DATA.dishes.filter((x) => x.meals.includes(m));
  const pref = fit.filter((x) => x.preferred === m);
  const other = fit.filter((x) => x.preferred !== m);
  return `<option value="">— не выбрано —</option>` +
    (pref.length ? `<optgroup label="Обычно на ${MEAL_NAMES[m].toLowerCase()}">${pref.map(opt).join('')}</optgroup>` : '') +
    (other.length ? `<optgroup label="Тоже можно">${other.map(opt).join('')}</optgroup>` : '');
}

function renderMeal(d, m, eff, sundayWarn) {
  const k = key(d, m), c = peek(k), e = eff[k];
  const target = PEOPLE.map((p) => `${p.name[0]} ${r0(p.kcal_target * DATA.meal_split[m])}`).join(' · ');
  let body = '';

  if (e.type === 'leftover') {
    const dish = DISHES[e.dish];
    body = `<div class="leftover">остатки: <b>${esc(dish.name)}</b>
      <small>из: ${label(e.from)}</small></div>
      ${kcalLine(dish, e.optOff)}`;
  } else {
    body = `<select data-act="dish" data-key="${k}" aria-label="${DAYS[d]}, ${MEAL_NAMES[m]}">${dishOptions(d, m, c.dish, eff)}</select>`;
    if (e.type === 'cook') {
      const dish = DISHES[e.dish];
      body += `<div class="seg">
        ${[2, 4].map((n) => `<label><input type="radio" name="p-${k}" value="${n}" data-act="portions" data-key="${k}" ${e.portions === n ? 'checked' : ''}>${n} порции</label>`).join('')}
      </div>`;
      body += dish.ingredients.filter((i) => i.optional).map((i) => `
        <label class="check"><input type="checkbox" data-act="optional" data-key="${k}" data-ing="${esc(i.ingredient)}" ${e.optOff.includes(i.ingredient) ? '' : 'checked'}>
        добавить ${esc(i.ingredient)}</label>`).join('');
      if (sundayWarn[k]) body += `<div class="warning">Остатки с воскресенья некуда перенести.</div>`;
      body += kcalLine(dish, e.optOff);
      body += renderRecipe(k, dish, e);
    }
  }

  return `<div class="meal">
    <div class="meal-head"><span class="meal-name">${MEAL_NAMES[m]}</span><span class="meal-target">${esc(target)} ккал</span></div>
    ${body}
    ${renderNote(k, c)}
  </div>`;
}

function openAttr(id) { return ui.open.has(id) ? 'open' : ''; }

function notePreview(c) {
  const parts = [];
  if (c.note && c.note.trim()) parts.push(c.note.trim());
  const n = lines(c.extras).length;
  if (n) parts.push(`покупок: ${n}`);
  return parts.length ? ': ' + parts.join(' · ') : '';
}

function renderNote(k, c) {
  const id = `note-${k}`;
  return `<details data-open-id="${id}" ${openAttr(id)}>
    <summary>Заметка<span class="note-preview">${esc(notePreview(c))}</span></summary>
    <div class="details-body">
      <label for="${id}-t">Комментарий</label>
      <textarea id="${id}-t" data-act="note" data-key="${k}" placeholder="например: обедаем у родителей">${esc(c.note)}</textarea>
      <label for="${id}-e">Докупить — каждое с новой строки</label>
      <textarea id="${id}-e" data-act="extras" data-key="${k}" placeholder="шашлык 1 кг&#10;угли">${esc(c.extras)}</textarea>
    </div>
  </details>`;
}

function fmtNum(x) { return (Math.round(x * 10) / 10).toLocaleString('ru-RU'); }

function renderRecipe(k, dish, e) {
  const id = `recipe-${k}`;
  const mult = e.portions / 2;
  const n = nutrition(dish, e.optOff);
  const who = (w) => w === 'both' ? 'общее' : esc((PEOPLE.find((p) => p.id === w) || {}).name || w);
  const items = dish.ingredients.map((i) => {
    const info = DATA.ingredients[i.ingredient] || {};
    const g = i.grams * mult;
    const off = i.optional && e.optOff.includes(i.ingredient);
    const pcs = info.unit && info.grams_per_unit ? ` (${fmtNum(g / info.grams_per_unit)} ${esc(info.unit)})` : '';
    return `<li class="${off ? 'off' : ''}">${esc(i.ingredient)} — ${fmtNum(g)} г${pcs}
      <span class="tag">· ${who(i.who)}${info.pantry ? ' · есть дома' : ''}${off ? ' · не добавляем' : ''}</span></li>`;
  }).join('');
  const hasShared = activeIngredients(dish, e.optOff).some((i) => i.who === 'both');
  return `<details data-open-id="${id}" ${openAttr(id)}>
    <summary>Рецепт и КБЖУ</summary>
    <div class="details-body">
      <p class="muted">На ${e.portions} порции</p>
      <ul class="ing-list">${items}</ul>
      <table class="nutr">
        <tr><th>На порцию</th><th>ккал</th><th>Б</th><th>Ж</th><th>У</th></tr>
        ${PEOPLE.map((p) => `<tr><td>${esc(p.name)}</td><td>${r0(n[p.id].kcal)}</td><td>${r0(n[p.id].protein)}</td><td>${r0(n[p.id].fat)}</td><td>${r0(n[p.id].carbs)}</td></tr>`).join('')}
      </table>
      ${dish.note ? `<p class="muted">${esc(dish.note)}</p>` : ''}
      ${hasShared ? `
        <label for="${id}-w">Вес готового блюда, г</label>
        <input id="${id}-w" type="number" inputmode="numeric" min="0" data-act="weight" data-key="${k}" value="${esc(peek(k).weight)}">
        <div class="weight-out" id="${id}-wo">${weightText(k)}</div>` : ''}
    </div>
  </details>`;
}

function weightText(k) {
  const c = peek(k);
  const w = Number(c.weight);
  if (!w || w <= 0) return '';
  const meals = c.portions === 4 ? 2 : 1;
  const per = w / meals;
  const parts = PEOPLE.map((p) => `${esc(p.name)}: <b>${r0(per * p.kcal_target / TOTAL_KCAL)} г</b>`).join(' · ');
  const personal = DISHES[c.dish].ingredients.some((i) => i.who !== 'both') ? ' Личные продукты — отдельно.' : '';
  return meals === 2
    ? `На каждый приём: ${parts}.${personal}`
    : `${parts}.${personal}`;
}

function renderTotals(d, eff) {
  const es = MEALS.map((m) => eff[key(d, m)]);
  const filled = es.filter((e) => e.type !== 'empty');
  const all = filled.length === es.length;
  const sums = {};
  for (const p of PEOPLE) sums[p.id] = { kcal: 0, protein: 0 };
  for (const e of filled) {
    const n = nutrition(DISHES[e.dish], e.optOff);
    for (const p of PEOPLE) { sums[p.id].kcal += n[p.id].kcal; sums[p.id].protein += n[p.id].protein; }
  }
  const rows = PEOPLE.map((p) => {
    const s = sums[p.id];
    let badge = '';
    if (all) {
      const dev = r0((s.kcal - p.kcal_target) / p.kcal_target * 100);
      const cls = Math.abs(dev) <= 10 ? 'ok' : 'warn';
      badge = `<span class="badge ${cls}">${dev > 0 ? '+' : dev < 0 ? '−' : ''}${Math.abs(dev)}%</span>`;
    }
    return `<div class="row"><span><b>${esc(p.name)}</b>: ${r0(s.kcal)} / ${p.kcal_target} ккал · белок ${r0(s.protein)} г</span>${badge}</div>`;
  }).join('');
  return `<div class="totals">${rows}${all ? '' : '<div class="partial">Не все приёмы пищи запланированы</div>'}</div>`;
}

// ---------- список покупок ----------

function plural(n, forms) {
  const a = n % 10, b = n % 100;
  if (a === 1 && b !== 11) return forms[0];
  if (a >= 2 && a <= 4 && (b < 12 || b > 14)) return forms[1];
  return forms[2];
}

// «ломтик» → ломтика/ломтиков, «банка (130 г нетто)» → банки/банок (130 г нетто), «шт» без изменений.
function unitName(unit, n) {
  const m = unit.match(/^(\S+)(.*)$/);
  const w = m[1], rest = m[2];
  let forms;
  if (w === 'шт' || w.endsWith('.')) forms = [w, w, w];
  else if (w.endsWith('ка')) forms = [w, w.slice(0, -1) + 'и', w.slice(0, -2) + 'ок'];
  else if (w.endsWith('а')) forms = [w, w.slice(0, -1) + 'ы', w.slice(0, -1)];
  else if (/[бвгджзклмнпрстфхцчшщ]$/.test(w)) forms = [w, w + 'а', w + 'ов'];
  else forms = [w, w, w];
  return plural(n, forms) + rest;
}

function fmtGrams(g) {
  if (g >= 1000) return (g / 1000).toLocaleString('ru-RU', { maximumFractionDigits: 2 }) + ' кг';
  return r0(g) + ' г';
}

function formatItem(name, grams) {
  const info = DATA.ingredients[name] || {};
  if (info.unit && info.grams_per_unit) {
    const n = Math.ceil(grams / info.grams_per_unit - 1e-9);
    let amount = `${n} ${unitName(info.unit, n)}`;
    if (info.unit !== 'шт' && !/\d\s*г/.test(info.unit)) amount += ` (~${fmtGrams(n * info.grams_per_unit)})`;
    return `${name.replace(/\s*\([^)]*\)\s*$/, '')} — ${amount}`;
  }
  return `${name} — ${fmtGrams(Math.ceil(grams / 10 - 1e-9) * 10)}`;
}

function buildShopping() {
  const { eff } = computeWeek();
  const totals = new Map();
  for (const e of Object.values(eff)) {
    if (e.type !== 'cook') continue;
    const mult = e.portions / 2;
    for (const i of activeIngredients(DISHES[e.dish], e.optOff)) {
      const info = DATA.ingredients[i.ingredient];
      if (!info || info.pantry) continue;
      totals.set(i.ingredient, (totals.get(i.ingredient) || 0) + i.grams * mult);
    }
  }
  const categories = [...new Set(Object.values(DATA.ingredients).map((x) => x.category))];
  const groups = categories.map((cat) => ({
    title: cat,
    items: [...totals.keys()].filter((n) => DATA.ingredients[n].category === cat)
      .sort((a, b) => a.localeCompare(b, 'ru')).map((n) => formatItem(n, totals.get(n))),
  })).filter((g) => g.items.length);

  const extras = [];
  DAYS.forEach((_, d) => MEALS.forEach((m) => {
    for (const l of lines(peek(key(d, m)).extras)) extras.push(`${DAYS_SHORT[d]}: ${l}`);
  }));
  if (extras.length) groups.push({ title: 'Дополнительно', items: extras });
  return groups;
}

function renderShopping() {
  const groups = buildShopping();
  $('#shopping').innerHTML = groups.length
    ? groups.map((g) => `<div class="list-card"><h3>${esc(g.title)}</h3><ul>${g.items.map((i) => `<li>${esc(i)}</li>`).join('')}</ul></div>`).join('')
    : '<p class="muted">Пока пусто</p>';
}

function shoppingText() {
  return 'Список покупок\n\n' + buildShopping().map((g) => `${g.title}\n${g.items.map((i) => '• ' + i).join('\n')}`).join('\n\n');
}

// ---------- меню по дням ----------

function mealText(k, e) {
  const c = peek(k);
  const note = c.note && c.note.trim();
  if (e.type === 'empty') return 'вне дома' + (note ? ` (${note})` : '');
  const dish = DISHES[e.dish];
  const extra = [];
  if (e.type === 'leftover') extra.push('вчерашнее');
  const off = dish.ingredients.filter((i) => i.optional && e.optOff.includes(i.ingredient)).map((i) => i.ingredient);
  if (off.length) extra.push('без: ' + off.join(', '));
  if (note) extra.push(note);
  return dish.name + (extra.length ? ` (${extra.join('; ')})` : '');
}

function buildMenu() {
  const { eff } = computeWeek();
  return DAYS.map((dayName, d) => ({
    day: dayName,
    meals: MEALS.map((m) => `${MEAL_NAMES[m].toLowerCase()} — ${mealText(key(d, m), eff[key(d, m)])}`),
  }));
}

function renderMenu() {
  $('#menu').innerHTML = `<div class="list-card">${buildMenu().map((x) =>
    `<p class="menu-day"><b>${x.day}</b>${x.meals.map(esc).join('<br>')}</p>`).join('')}</div>`;
}

function menuText() {
  return buildMenu().map((x) => `${x.day}: ${x.meals.join(', ')}`).join('\n');
}

// ---------- события ----------

async function copyText(text, btn) {
  let ok = false;
  try { await navigator.clipboard.writeText(text); ok = true; } catch (e) {
    const ta = document.createElement('textarea');
    ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta); ta.select();
    try { ok = document.execCommand('copy'); } catch (e2) { /* ignore */ }
    ta.remove();
  }
  const old = btn.textContent;
  btn.textContent = ok ? 'Скопировано ✓' : 'Не получилось скопировать';
  setTimeout(() => { btn.textContent = old; }, 1500);
}

function bindEvents() {
  document.querySelectorAll('.tab').forEach((b) => b.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach((x) => x.classList.toggle('active', x === b));
    document.querySelectorAll('.tab-panel').forEach((p) => { p.hidden = p.id !== 'tab-' + b.dataset.tab; });
    const top = $('.tabs').getBoundingClientRect().top + window.scrollY;
    if (window.scrollY > top) window.scrollTo(0, top);
  }));

  document.querySelectorAll('[data-copy]').forEach((b) => b.addEventListener('click', () =>
    copyText(b.dataset.copy === 'shopping' ? shoppingText() : menuText(), b)));

  $('#clear-week').addEventListener('click', () => {
    if (!confirm('Очистить всю неделю? Блюда, заметки и доп. покупки будут удалены.')) return;
    state = { cells: {} };
    ui.open.clear();
    commit();
  });

  const plan = $('#plan');
  plan.addEventListener('change', (ev) => {
    const t = ev.target, k = t.dataset.key;
    if (t.dataset.act === 'dish') setDish(k, t.value);
    else if (t.dataset.act === 'portions') setPortions(k, Number(t.value));
    else if (t.dataset.act === 'optional') {
      const c = cell(k), name = t.dataset.ing;
      c.optOff = (c.optOff || []).filter((x) => x !== name);
      if (!t.checked) c.optOff.push(name);
      commit();
    }
  });

  // Текстовые поля не перерисовывают план, чтобы не сбивать ввод.
  plan.addEventListener('input', (ev) => {
    const t = ev.target, k = t.dataset.key, act = t.dataset.act;
    if (act === 'note' || act === 'extras') {
      cell(k)[act] = t.value;
      const prev = t.closest('details').querySelector('.note-preview');
      prev.textContent = notePreview(peek(k));
    } else if (act === 'weight') {
      cell(k).weight = t.value;
      $(`#recipe-${k}-wo`).innerHTML = weightText(k);
    } else return;
    save();
    renderResults();
  });

  plan.addEventListener('toggle', (ev) => {
    const id = ev.target.dataset && ev.target.dataset.openId;
    if (!id) return;
    if (ev.target.open) ui.open.add(id); else ui.open.delete(id);
  }, true);
}

init();
