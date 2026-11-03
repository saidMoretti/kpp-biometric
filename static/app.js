const video = document.querySelector('#video');
const cameraFrame = document.querySelector('#camera-frame');
const cameraToggle = document.querySelector('#camera-toggle');
const scanButton = document.querySelector('#scan');
const dialog = document.querySelector('#enroll-dialog');
const enrollVideo = document.querySelector('#enroll-video');
let stream = null;
let enrollStream = null;
let enrollUsesTerminalStream = false;

function setClock() {
  document.querySelector('#clock').textContent = new Intl.DateTimeFormat('ru-RU', {hour:'2-digit',minute:'2-digit',second:'2-digit'}).format(new Date());
}
setClock(); setInterval(setClock, 1000);

async function api(url, options = {}) {
  const response = await fetch(url, {headers:{'Content-Type':'application/json',...(options.headers || {})}, ...options});
  const data = await response.json();
  if (!response.ok) throw new Error(data.detail || 'Ошибка запроса');
  return data;
}

async function startCamera(target = video) {
  const opened = await navigator.mediaDevices.getUserMedia({video:{facingMode:'user',width:{ideal:1280},height:{ideal:720}},audio:false});
  target.srcObject = opened;
  await target.play();
  return opened;
}

cameraToggle.addEventListener('click', async () => {
  if (stream) { stopCamera(); return; }
  try {
    stream = await startCamera();
    cameraFrame.classList.add('ready');
    cameraToggle.textContent = 'Выключить камеру';
    scanButton.disabled = false;
    document.querySelector('#camera-state').textContent = 'СИГНАЛ ЕСТЬ';
    document.querySelector('#camera-help').textContent = 'Расположитесь по центру кадра';
  } catch (error) { showResult(false, 'КАМЕРА НЕДОСТУПНА', error.message); }
});

function stopCamera() {
  [stream, enrollStream].forEach(item => item?.getTracks().forEach(track => track.stop()));
  stream = null; enrollStream = null; video.srcObject = null; enrollVideo.srcObject = null;
  enrollUsesTerminalStream = false;
  cameraFrame.classList.remove('ready');
  document.querySelector('.enroll-camera').classList.remove('active');
  cameraToggle.textContent = 'Включить камеру'; scanButton.disabled = true;
  document.querySelector('#camera-state').textContent = 'ОЖИДАНИЕ';
}

function capture(target) {
  const canvas = document.createElement('canvas');
  canvas.width = target.videoWidth; canvas.height = target.videoHeight;
  canvas.getContext('2d').drawImage(target, 0, 0);
  return canvas.toDataURL('image/jpeg', .82);
}

function showResult(granted, label, message, employee = '') {
  const panel = document.querySelector('#result-panel');
  panel.classList.remove('granted','denied'); panel.classList.add(granted ? 'granted' : 'denied');
  document.querySelector('#result-icon').textContent = granted ? '✓' : '×';
  document.querySelector('#result-label').textContent = label;
  document.querySelector('#result-body').innerHTML = `<h2>${escapeHtml(employee || (granted ? 'Доступ разрешен' : 'Доступ запрещен'))}</h2><p>${escapeHtml(message)}</p>`;
  document.querySelector('#last-event').textContent = `${new Date().toLocaleTimeString('ru-RU')} · ${employee || 'Неизвестное лицо'} · ${granted ? 'Проход разрешен' : 'Отказ'}`;
}

function escapeHtml(value) { return String(value).replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char])); }

scanButton.addEventListener('click', async () => {
  if (!stream) return;
  scanButton.disabled = true; cameraFrame.classList.add('scanning');
  document.querySelector('#camera-state').textContent = 'ПРОВЕРКА ДВИЖЕНИЯ';
  document.querySelector('#camera-help').textContent = 'Плавно поверните голову в сторону';
  document.querySelector('#result-panel').classList.remove('granted','denied');
  document.querySelector('#result-label').textContent = 'ИДЕТ ПРОВЕРКА';
  document.querySelector('#result-icon').textContent = '…';
  document.querySelector('#result-body').innerHTML = '<h2>Смотрите в камеру</h2><p>Плавно поверните голову в сторону. Выполняется локальная обработка кадров.</p>';
  try {
    const frames = [];
    for (let i = 0; i < 8; i++) { frames.push(capture(video)); await new Promise(resolve => setTimeout(resolve, 280)); }
    const result = await api('/api/verify', {method:'POST',body:JSON.stringify({frames,zone_level:Number(document.querySelector('#zone').value)})});
    showResult(result.granted, result.granted ? 'ПРОХОД РАЗРЕШЕН' : 'В ДОСТУПЕ ОТКАЗАНО', result.reason, result.employee || 'Сотрудник не идентифицирован');
  } catch (error) { showResult(false, 'В ДОСТУПЕ ОТКАЗАНО', error.message); }
  finally { scanButton.disabled = false; cameraFrame.classList.remove('scanning'); document.querySelector('#camera-state').textContent = 'СИГНАЛ ЕСТЬ'; document.querySelector('#camera-help').textContent = 'Расположитесь по центру кадра'; refreshAdmin(); }
});

document.querySelectorAll('.tab').forEach(button => button.addEventListener('click', () => {
  document.querySelectorAll('.tab').forEach(item => item.classList.toggle('active', item === button));
  document.querySelector('#terminal-view').classList.toggle('hidden', button.dataset.view !== 'terminal');
  document.querySelector('#admin-view').classList.toggle('hidden', button.dataset.view !== 'admin');
  if (button.dataset.view === 'admin') refreshAdmin();
}));

async function refreshAdmin() {
  try {
    const [staff, events] = await Promise.all([api('/api/staff'), api('/api/events?limit=100')]);
    document.querySelector('#staff-count').textContent = staff.length;
    document.querySelector('#event-count').textContent = events.length;
    document.querySelector('#staff-caption').textContent = `${staff.length} записей`;
    document.querySelector('#staff-empty').hidden = staff.length > 0;
    document.querySelector('#events-empty').hidden = events.length > 0;
    document.querySelector('#last-time').textContent = events.length ? new Date(events[0].occurred_at).toLocaleTimeString('ru-RU',{hour:'2-digit',minute:'2-digit'}) : '—';
    document.querySelector('#staff-body').innerHTML = staff.map(person => `<tr><td>${escapeHtml(person.name)}</td><td>${escapeHtml(person.personnel_id)}</td><td><select class="clearance-select" aria-label="Уровень допуска ${escapeHtml(person.name)}"><option value="1" ${person.clearance === 1 ? 'selected' : ''}>1 · Общая</option><option value="2" ${person.clearance === 2 ? 'selected' : ''}>2 · Ограниченная</option><option value="3" ${person.clearance === 3 ? 'selected' : ''}>3 · Особая</option></select></td><td>${new Date(person.created_at).toLocaleDateString('ru-RU')}</td><td><div class="row-actions"><button class="text-button clearance-save" data-id="${person.id}">Сохранить</button><button class="text-button remove" data-id="${person.id}" aria-label="Удалить ${escapeHtml(person.name)}">Удалить</button></div></td></tr>`).join('');
    document.querySelector('#events-body').innerHTML = events.map(event => {
      const action = event.result === 'granted'
        ? `Проход разрешен · зона ${event.zone_level}`
        : event.result === 'denied'
          ? `Отказ · зона ${event.zone_level}: ${event.reason}`
          : event.reason;
      const eventClass = event.result === 'granted' ? 'event-granted' : event.result === 'denied' ? 'event-denied' : 'event-record';
      return `<tr><td>${new Date(event.occurred_at).toLocaleTimeString('ru-RU',{hour:'2-digit',minute:'2-digit',second:'2-digit'})}</td><td>${escapeHtml(event.employee_name || 'Неизвестное лицо')}</td><td class="${eventClass}">${escapeHtml(action)}</td></tr>`;
    }).join('');
    document.querySelectorAll('.remove').forEach(button => button.addEventListener('click', async () => { if (confirm('Удалить биометрическую запись сотрудника?')) { await api(`/api/staff/${button.dataset.id}`,{method:'DELETE'}); refreshAdmin(); } }));
    document.querySelectorAll('.clearance-save').forEach(button => button.addEventListener('click', async () => {
      const clearance = Number(button.closest('tr').querySelector('.clearance-select').value);
      button.disabled = true;
      try {
        await api(`/api/staff/${button.dataset.id}`, {method:'PATCH', body:JSON.stringify({clearance})});
        button.textContent = 'Сохранено';
      } catch (error) {
        alert(error.message);
      } finally {
        button.disabled = false;
      }
    }));
  } catch (error) { console.error(error); }
}

document.querySelector('#refresh-events').addEventListener('click', refreshAdmin);
document.querySelector('#add-employee').addEventListener('click', async () => {
  document.querySelector('#form-error').textContent = '';
  document.querySelector('#enroll-form').reset();
  document.querySelector('#enroll-submit').disabled = true;
  const preview = document.querySelector('.enroll-camera');
  preview.classList.remove('active');
  if (stream?.active) {
    enrollUsesTerminalStream = true;
    enrollVideo.srcObject = stream;
    await enrollVideo.play();
    preview.classList.add('active');
    document.querySelector('#enroll-submit').disabled = false;
  } else {
    enrollUsesTerminalStream = false;
    enrollVideo.srcObject = null;
  }
  dialog.showModal();
});

document.querySelector('#enroll-camera-start').addEventListener('click', async () => {
  const button = document.querySelector('#enroll-camera-start');
  button.disabled = true;
  try {
    enrollStream = await startCamera(enrollVideo);
    enrollUsesTerminalStream = false;
    document.querySelector('.enroll-camera').classList.add('active');
    document.querySelector('#enroll-submit').disabled = false;
  } catch (error) {
    document.querySelector('#form-error').textContent = `Не удалось открыть камеру: ${error.message}`;
    button.disabled = false;
  }
});

function closeDialog() { dialog.close(); document.querySelector('#enroll-form').reset(); }
document.querySelector('#dialog-close').addEventListener('click', closeDialog);
document.querySelector('#dialog-cancel').addEventListener('click', closeDialog);
dialog.addEventListener('close', () => {
  if (!enrollUsesTerminalStream) enrollStream?.getTracks().forEach(track => track.stop());
  enrollStream = null;
  enrollUsesTerminalStream = false;
  enrollVideo.srcObject = null;
  document.querySelector('.enroll-camera').classList.remove('active');
  document.querySelector('#enroll-camera-start').disabled = false;
});
document.querySelector('#enroll-form').addEventListener('submit', async event => {
  event.preventDefault();
  if (!enrollVideo.videoWidth) {
    document.querySelector('#form-error').textContent = 'Сначала включите камеру.';
    return;
  }
  const form = new FormData(event.currentTarget);
  const button = document.querySelector('#enroll-submit'); button.disabled = true;
  const originalLabel = button.textContent;
  button.textContent = 'Сканирование…';
  try {
    const frames = [];
    for (let i = 0; i < 5; i++) {
      frames.push(capture(enrollVideo));
      if (i < 4) await new Promise(resolve => setTimeout(resolve, 240));
    }
    await api('/api/staff',{method:'POST',body:JSON.stringify({name:form.get('name'),personnel_id:form.get('personnel_id'),clearance:Number(form.get('clearance')),frames})});
    closeDialog(); refreshAdmin();
  } catch (error) { document.querySelector('#form-error').textContent = error.message; }
  finally { button.textContent = originalLabel; button.disabled = !enrollVideo.videoWidth; }
});

refreshAdmin();
