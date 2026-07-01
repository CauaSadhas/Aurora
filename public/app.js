const qs = (selector, context = document) => context.querySelector(selector);
const qsa = (selector, context = document) => [...context.querySelectorAll(selector)];

function formatTime(value) {
  const seconds = Math.max(0, Number(value) || 0);
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const rest = seconds % 60;
  if (hours) return `${hours}h ${minutes}m`;
  if (minutes) return `${minutes}m ${rest}s`;
  return `${rest}s`;
}

qsa('[data-format-seconds]').forEach((element) => {
  element.textContent = formatTime(element.dataset.formatSeconds);
});

qsa('[data-live-timer]').forEach((element) => {
  let seconds = Number(element.dataset.seconds || 0);
  const render = () => { element.textContent = formatTime(seconds); };
  render();
  if (element.dataset.running === '1') {
    window.setInterval(() => { seconds += 1; render(); }, 1000);
  }
});

function closeModal(modal) {
  if (!modal) return;
  modal.classList.remove('open');
  modal.setAttribute('aria-hidden', 'true');
  if (!qs('.modal.open') && !qs('.drawer')) document.body.classList.remove('modal-open');
}

function openModal(modal, trigger) {
  if (!modal) return;
  modal.classList.add('open');
  modal.removeAttribute('aria-hidden');
  document.body.classList.add('modal-open');
  modal.dataset.triggerId = trigger?.id || '';
  window.setTimeout(() => {
    const focusable = qs('input:not([type="hidden"]), select, textarea, button', modal);
    focusable?.focus();
  }, 40);
}

qsa('[data-open-modal]').forEach((button, index) => {
  if (!button.id) button.id = `modal-trigger-${index}`;
  button.addEventListener('click', () => {
    const modal = qs(`#${button.dataset.openModal}`);
    const column = button.dataset.column;
    if (column && qs('#task-column')) qs('#task-column').value = column;
    openModal(modal, button);
  });
});

qsa('[data-close-modal]').forEach((button) => {
  button.addEventListener('click', () => closeModal(button.closest('.modal')));
});

qsa('.modal').forEach((modal) => {
  modal.setAttribute('aria-hidden', modal.classList.contains('open') ? 'false' : 'true');
  modal.addEventListener('click', (event) => {
    if (event.target === modal) closeModal(modal);
  });
});

if (qs('.drawer')) document.body.classList.add('modal-open');

document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape') return;
  const modal = qs('.modal.open');
  if (modal) return closeModal(modal);
  const overlay = qs('.drawer-overlay');
  if (overlay) window.location.assign(overlay.href);
});

qsa('[data-auto-dismiss]').forEach((flash) => {
  window.setTimeout(() => {
    flash.classList.add('is-hiding');
    window.setTimeout(() => flash.remove(), 220);
  }, 4200);
});

qsa('form').forEach((form) => {
  form.addEventListener('submit', () => {
    const submit = qs('button[type="submit"], button:not([type])', form);
    if (!submit || submit.dataset.noLoading === 'true') return;
    submit.classList.add('is-loading');
    submit.setAttribute('aria-busy', 'true');
  });
});

let dragged = null;
let dragOrigin = null;

function updateColumnCounts() {
  qsa('[data-column-id]').forEach((column) => {
    const count = qsa('.task-card', column).length;
    const counter = qs('[data-column-count]', column);
    if (counter) counter.textContent = String(count);
  });
}

qsa('.task-card[draggable]').forEach((card) => {
  card.addEventListener('dragstart', () => {
    dragged = card;
    dragOrigin = { parent: card.parentElement, next: card.nextElementSibling };
    card.classList.add('dragging');
    card.setAttribute('aria-grabbed', 'true');
  });
  card.addEventListener('dragend', () => {
    card.classList.remove('dragging');
    card.removeAttribute('aria-grabbed');
    qsa('.drop-zone.drag-over').forEach((zone) => zone.classList.remove('drag-over'));
    dragged = null;
    dragOrigin = null;
  });
});

qsa('.drop-zone').forEach((zone) => {
  zone.addEventListener('dragover', (event) => {
    event.preventDefault();
    zone.classList.add('drag-over');
  });
  zone.addEventListener('dragleave', (event) => {
    if (!zone.contains(event.relatedTarget)) zone.classList.remove('drag-over');
  });
  zone.addEventListener('drop', async (event) => {
    event.preventDefault();
    zone.classList.remove('drag-over');
    if (!dragged) return;

    const column = zone.closest('[data-column-id]')?.dataset.columnId;
    if (!column) return;
    const addButton = qs('.add-card-inline', zone);
    zone.insertBefore(dragged, addButton || null);
    updateColumnCounts();

    try {
      const response = await fetch(`/api/tasks/${dragged.dataset.taskId}/move`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ column_id: Number(column) })
      });
      if (!response.ok) throw new Error('Falha ao mover tarefa');
    } catch (error) {
      if (dragOrigin?.parent) dragOrigin.parent.insertBefore(dragged, dragOrigin.next || null);
      updateColumnCounts();
      window.alert('Não foi possível mover a tarefa. Tente novamente.');
    }
  });
});

const kanban = qs('[data-remember-scroll]');
if (kanban) {
  const key = `aurora-kanban-scroll:${kanban.dataset.boardId || location.pathname}`;
  const saved = Number(sessionStorage.getItem(key) || 0);
  if (saved) kanban.scrollLeft = saved;
  let scrollTimer;
  kanban.addEventListener('scroll', () => {
    window.clearTimeout(scrollTimer);
    scrollTimer = window.setTimeout(() => sessionStorage.setItem(key, String(kanban.scrollLeft)), 80);
  }, { passive: true });
}

const activeView = qs('.view-tabs a.active');
activeView?.scrollIntoView({ inline: 'center', block: 'nearest' });

const search = qs('[data-table-search]');
if (search) {
  const count = qs('[data-visible-count]');
  search.addEventListener('input', () => {
    const value = search.value.trim().toLocaleLowerCase('pt-BR');
    let visible = 0;
    qsa('[data-search-row]').forEach((row) => {
      const match = row.textContent.toLocaleLowerCase('pt-BR').includes(value);
      row.hidden = !match;
      if (match) visible += 1;
    });
    if (count) count.textContent = String(visible);
  });
}

const boardSelect = qs('#obligation-board');
const columnSelect = qs('#obligation-column');
function filterColumns() {
  if (!boardSelect || !columnSelect) return;
  const board = boardSelect.value;
  let first = null;
  qsa('option', columnSelect).forEach((option) => {
    option.hidden = option.dataset.board !== board;
    option.disabled = option.hidden;
    if (!option.hidden && !first) first = option;
  });
  if (first) columnSelect.value = first.value;
}
if (boardSelect) {
  boardSelect.addEventListener('change', filterColumns);
  filterColumns();
}
