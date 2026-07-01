const qs=(s,c=document)=>c.querySelector(s), qsa=(s,c=document)=>[...c.querySelectorAll(s)];
const formatTime=(seconds)=>{seconds=Math.max(0,Number(seconds)||0);const h=Math.floor(seconds/3600),m=Math.floor((seconds%3600)/60),s=seconds%60;return h?`${h}h ${m}m`:m?`${m}m ${s}s`:`${s}s`};
qsa('[data-format-seconds]').forEach(el=>el.textContent=formatTime(el.dataset.formatSeconds));
qsa('[data-live-timer]').forEach(el=>{let sec=Number(el.dataset.seconds||0);const render=()=>el.textContent=`◉ ${formatTime(sec)}`;render();if(el.dataset.running==='1')setInterval(()=>{sec++;render()},1000)});
qsa('[data-open-modal]').forEach(btn=>btn.addEventListener('click',()=>{const modal=qs('#'+btn.dataset.openModal);if(modal){modal.classList.add('open');const col=btn.dataset.column;if(col&&qs('#task-column'))qs('#task-column').value=col}}));
qsa('[data-close-modal]').forEach(btn=>btn.addEventListener('click',()=>btn.closest('.modal').classList.remove('open')));
qsa('.modal').forEach(modal=>modal.addEventListener('click',e=>{if(e.target===modal)modal.classList.remove('open')}));
let dragged=null;
qsa('.task-card[draggable]').forEach(card=>{card.addEventListener('dragstart',()=>{dragged=card;card.classList.add('dragging')});card.addEventListener('dragend',()=>{card.classList.remove('dragging');dragged=null})});
qsa('.drop-zone').forEach(zone=>{zone.addEventListener('dragover',e=>{e.preventDefault();zone.classList.add('drag-over')});zone.addEventListener('dragleave',()=>zone.classList.remove('drag-over'));zone.addEventListener('drop',async e=>{e.preventDefault();zone.classList.remove('drag-over');if(!dragged)return;const column=zone.closest('[data-column-id]').dataset.columnId;zone.prepend(dragged);try{const r=await fetch(`/api/tasks/${dragged.dataset.taskId}/move`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({column_id:Number(column)})});if(!r.ok)location.reload()}catch{location.reload()}})});
const search=qs('[data-table-search]');if(search)search.addEventListener('input',()=>{const value=search.value.toLowerCase();qsa('[data-search-row]').forEach(row=>row.hidden=!row.textContent.toLowerCase().includes(value))});
const boardSelect=qs('#obligation-board'), columnSelect=qs('#obligation-column');
function filterColumns(){if(!boardSelect||!columnSelect)return;const board=boardSelect.value;let first=null;qsa('option',columnSelect).forEach(o=>{o.hidden=o.dataset.board!==board;if(!o.hidden&&!first)first=o});if(first)columnSelect.value=first.value}
if(boardSelect){boardSelect.addEventListener('change',filterColumns);filterColumns()}
