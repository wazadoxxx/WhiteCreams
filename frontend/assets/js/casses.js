const API_BASE_URL = window.__API_BASE_URL__ || '';

const authToken = localStorage.getItem('authToken');
const authUserRaw = localStorage.getItem('authUser');

if (!authToken || !authUserRaw) {
    window.location.href = 'login.html';
    throw new Error('Utilisateur non connecte');
}

const connectedUser = JSON.parse(authUserRaw);

const playerNameEl = document.getElementById('playerName');
const heistsTableBody = document.getElementById('heistsTableBody');
const logoutButton = document.getElementById('logoutButton');

const heistModal = document.getElementById('heistModal');
const drugModal = document.getElementById('drugModal');
const openHeistModalButton = document.getElementById('openHeistModal');
const openDrugModalButton = document.getElementById('openDrugModal');
const heistForm = document.getElementById('heistForm');
const drugForm = document.getElementById('drugForm');
const heistTypeSelect = document.getElementById('heistType');
const drugTypeSelect = document.getElementById('drugType');
const editHeistModal = document.getElementById('editHeistModal');
const editHeistForm = document.getElementById('editHeistForm');
const editHeistIdInput = document.getElementById('editHeistId');
const editHeistTypeSelect = document.getElementById('editHeistType');
const editHeistGainInput = document.getElementById('editHeistGain');
const editDrugModal = document.getElementById('editDrugModal');
const editDrugForm = document.getElementById('editDrugForm');
const editDrugIdInput = document.getElementById('editDrugId');
const editDrugTypeSelect = document.getElementById('editDrugType');
const editDrugQuantityInput = document.getElementById('editDrugQuantity');
const editDrugRevenueInput = document.getElementById('editDrugRevenue');

let latestActivities = [];
let cooldownState = [];

const HEIST_COOLDOWNS = [
    {
        key: 'go-fast',
        durationMs: 24 * 60 * 60 * 1000,
        aliases: ['gofast']
    },
    {
        key: 'cambu',
        durationMs: 3 * 60 * 60 * 1000,
        aliases: ['cambu', 'cambriolage']
    },
    {
        key: 'superette',
        durationMs: 3 * 60 * 60 * 1000,
        aliases: ['superette']
    },
    {
        key: 'atm',
        durationMs: 2 * 60 * 60 * 1000,
        aliases: ['atm']
    }
];

function formatMoney(value) {
    return new Intl.NumberFormat('fr-FR').format(value) + ' $';
}

function formatDate(dateIso) {
    const date = new Date(dateIso);
    return date.toLocaleString('fr-FR', {
        day: '2-digit',
        month: '2-digit',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit'
    });
}

function fillSelect(select, values, placeholder) {
    select.innerHTML = '';

    if (!values.length) {
        const emptyOption = document.createElement('option');
        emptyOption.value = '';
        emptyOption.textContent = placeholder;
        select.appendChild(emptyOption);
        return;
    }

    values.forEach((value, index) => {
        const option = document.createElement('option');
        option.value = value;
        option.textContent = value;
        if (index === 0) {
            option.selected = true;
        }
        select.appendChild(option);
    });
}

function getNowIsoDateTime() {
    return new Date().toISOString();
}

function normalizeText(value) {
    return String(value || '')
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .replace(/[^a-z0-9]/g, '');
}

function formatDuration(ms) {
    const totalSeconds = Math.max(0, Math.floor(ms / 1000));
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;

    return [hours, minutes, seconds]
        .map((value) => String(value).padStart(2, '0'))
        .join(':');
}

function findCooldownConfigByType(heistType) {
    const normalizedType = normalizeText(heistType);

    return HEIST_COOLDOWNS.find((config) => config.aliases.some((alias) => normalizedType.includes(alias)));
}

function buildCooldownState(activities) {
    const latestByCooldownKey = {};

    activities
        .filter((activity) => activity.activityType === 'casse')
        .forEach((activity) => {
            const config = findCooldownConfigByType(activity.type);

            if (!config) {
                return;
            }

            const activityDate = new Date(activity.date);
            const timestamp = activityDate.getTime();

            if (Number.isNaN(timestamp)) {
                return;
            }

            const previous = latestByCooldownKey[config.key];
            if (!previous || timestamp > previous.timestamp) {
                latestByCooldownKey[config.key] = { timestamp, date: activityDate };
            }
        });

    return HEIST_COOLDOWNS.map((config) => {
        const latest = latestByCooldownKey[config.key] || null;

        return {
            key: config.key,
            durationMs: config.durationMs,
            latestTimestamp: latest ? latest.timestamp : null,
            availableAt: latest ? latest.timestamp + config.durationMs : null,
            latestDate: latest ? latest.date : null
        };
    });
}

function renderCooldowns() {
    const now = Date.now();

    cooldownState.forEach((cooldown) => {
        const timeElement = document.getElementById(`cooldown-${cooldown.key}`);
        const noteElement = document.getElementById(`cooldown-note-${cooldown.key}`);
        const cardElement = document.querySelector(`[data-cooldown="${cooldown.key}"]`);

        if (!timeElement || !noteElement || !cardElement) {
            return;
        }

        if (!cooldown.latestTimestamp || !cooldown.availableAt || !cooldown.latestDate) {
            timeElement.textContent = 'Pret';
            noteElement.textContent = 'Aucun casse enregistre, disponible maintenant.';
            cardElement.classList.add('is-ready');
            return;
        }

        const remainingMs = cooldown.availableAt - now;

        if (remainingMs <= 0) {
            timeElement.textContent = 'Pret';
            noteElement.textContent = `Disponible depuis ${formatDate(new Date(cooldown.availableAt).toISOString())}`;
            cardElement.classList.add('is-ready');
            return;
        }

        timeElement.textContent = formatDuration(remainingMs);
        noteElement.textContent = `Refaisable le ${formatDate(new Date(cooldown.availableAt).toISOString())}`;
        cardElement.classList.remove('is-ready');
    });
}

function openModal(modal) {
    modal.classList.remove('hidden');
}

function closeModal(modal) {
    modal.classList.add('hidden');
}

function wireModalCloseButtons() {
    document.querySelectorAll('[data-close]').forEach((button) => {
        button.addEventListener('click', () => {
            const modalId = button.getAttribute('data-close');
            const modal = document.getElementById(modalId);
            closeModal(modal);
        });
    });

    [heistModal, drugModal, editHeistModal, editDrugModal].forEach((modal) => {
        modal.addEventListener('click', (event) => {
            if (event.target === modal) {
                closeModal(modal);
            }
        });
    });
}

function renderHeists(heists) {
    heistsTableBody.innerHTML = '';
    latestActivities = heists;
    cooldownState = buildCooldownState(heists);
    renderCooldowns();

    heists.forEach((heist) => {
        const row = document.createElement('tr');
        const actionCell = heist.activityType === 'casse'
            ? `<button class="row-action" data-edit-heist-id="${heist.id}">Modifier</button>`
            : `<button class="row-action" data-edit-drug-id="${heist.id}">Modifier</button>`;

        row.innerHTML = `
      <td>${formatDate(heist.date)}</td>
      <td>${heist.type}</td>
      <td>${heist.moneyType || 'Sale'}</td>
            <td>${heist.activityType === 'drogue' ? (heist.quantity ?? 0) : '-'}</td>
      <td>${formatMoney(heist.gain)}</td>
      <td>${actionCell}</td>
    `;
        heistsTableBody.appendChild(row);
    });

    if (!heists.length) {
        const row = document.createElement('tr');
        row.innerHTML = '<td colspan="6">Aucune activite enregistree.</td>';
        heistsTableBody.appendChild(row);
    }
}

function openEditModalForHeist(activityId) {
    const target = latestActivities.find((activity) => String(activity.id) === String(activityId));

    if (!target || target.activityType !== 'casse') {
        return;
    }

    const rawId = String(target.id).replace('heist-', '');
    editHeistIdInput.value = rawId;
    editHeistTypeSelect.value = target.type;
    editHeistGainInput.value = String(target.gain || 0);
    openModal(editHeistModal);
}

function openEditModalForDrug(activityId) {
    const target = latestActivities.find((activity) => String(activity.id) === String(activityId));

    if (!target || target.activityType !== 'drogue') {
        return;
    }

    const rawId = String(target.id).replace('drug-', '');
    editDrugIdInput.value = rawId;
    editDrugTypeSelect.value = target.drugType || 'Inconnue';
    editDrugQuantityInput.value = String(target.quantity || 0);
    editDrugRevenueInput.value = String(target.gain || 0);
    openModal(editDrugModal);
}

async function loadHeists() {
    const response = await fetch(`${API_BASE_URL}/api/casses/${encodeURIComponent(connectedUser.pseudo)}`);
    const data = await response.json();

    if (!response.ok || !data.ok) {
        throw new Error(data.error || 'Erreur chargement casses');
    }

    renderHeists(data.heists || []);
}

async function loadSelectOptions() {
    const response = await fetch(`${API_BASE_URL}/api/casses-options`);
    const data = await response.json();

    if (!response.ok || !data.ok) {
        throw new Error(data.error || 'Erreur chargement des listes');
    }

    fillSelect(heistTypeSelect, data.heistTypes || [], 'Aucun type de casse disponible');
    fillSelect(editHeistTypeSelect, data.heistTypes || [], 'Aucun type de casse disponible');
    fillSelect(drugTypeSelect, data.drugTypes || [], 'Aucun type de drogue disponible');
    fillSelect(editDrugTypeSelect, data.drugTypes || [], 'Aucun type de drogue disponible');
}

async function submitHeist(event) {
    event.preventDefault();

    const type = document.getElementById('heistType').value;
    const gain = Number(document.getElementById('heistGain').value || 0);
    const date = getNowIsoDateTime();

    const response = await fetch(`${API_BASE_URL}/api/casses/${encodeURIComponent(connectedUser.pseudo)}/heists`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type, gain, date })
    });

    const data = await response.json();
    if (!response.ok || !data.ok) {
        throw new Error(data.error || 'Erreur ajout casse');
    }

    heistForm.reset();
    closeModal(heistModal);
    await loadHeists();
}

async function submitDrugSale(event) {
    event.preventDefault();

    const quantity = Number(document.getElementById('drugQuantity').value || 0);
    const revenue = Number(document.getElementById('drugRevenue').value || 0);
    const date = getNowIsoDateTime();
    const type = drugTypeSelect.value;

    const response = await fetch(`${API_BASE_URL}/api/casses/${encodeURIComponent(connectedUser.pseudo)}/drug-sales`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type, quantity, revenue, date })
    });

    const data = await response.json();
    if (!response.ok || !data.ok) {
        throw new Error(data.error || 'Erreur ajout vente de drogues');
    }

    drugForm.reset();
    closeModal(drugModal);
    await loadHeists();
}

async function submitHeistEdit(event) {
    event.preventDefault();

    const id = Number(editHeistIdInput.value);
    const type = editHeistTypeSelect.value;
    const gain = Number(editHeistGainInput.value || 0);

    const response = await fetch(`${API_BASE_URL}/api/casses/${encodeURIComponent(connectedUser.pseudo)}/heists/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type, gain })
    });

    const data = await response.json();
    if (!response.ok || !data.ok) {
        throw new Error(data.error || 'Erreur modification casse');
    }

    closeModal(editHeistModal);
    await loadHeists();
}

async function submitDrugEdit(event) {
    event.preventDefault();

    const id = Number(editDrugIdInput.value);
    const type = editDrugTypeSelect.value;
    const quantity = Number(editDrugQuantityInput.value || 0);
    const revenue = Number(editDrugRevenueInput.value || 0);

    const response = await fetch(`${API_BASE_URL}/api/casses/${encodeURIComponent(connectedUser.pseudo)}/drug-sales/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type, quantity, revenue })
    });

    const data = await response.json();
    if (!response.ok || !data.ok) {
        throw new Error(data.error || 'Erreur modification vente de drogues');
    }

    closeModal(editDrugModal);
    await loadHeists();
}

openHeistModalButton.addEventListener('click', () => openModal(heistModal));
openDrugModalButton.addEventListener('click', () => openModal(drugModal));
heistForm.addEventListener('submit', (event) => {
    submitHeist(event).catch((error) => alert(error.message));
});
drugForm.addEventListener('submit', (event) => {
    submitDrugSale(event).catch((error) => alert(error.message));
});
editHeistForm.addEventListener('submit', (event) => {
    submitHeistEdit(event).catch((error) => alert(error.message));
});
editDrugForm.addEventListener('submit', (event) => {
    submitDrugEdit(event).catch((error) => alert(error.message));
});
logoutButton.addEventListener('click', () => {
    localStorage.removeItem('authToken');
    localStorage.removeItem('authUser');
    window.location.href = 'login.html';
});

wireModalCloseButtons();
heistsTableBody.addEventListener('click', (event) => {
    const target = event.target;

    if (!(target instanceof HTMLElement)) {
        return;
    }

    const activityId = target.getAttribute('data-edit-heist-id');
    if (activityId) {
        openEditModalForHeist(activityId);
        return;
    }

    const drugActivityId = target.getAttribute('data-edit-drug-id');
    if (drugActivityId) {
        openEditModalForDrug(drugActivityId);
    }
});
playerNameEl.textContent = connectedUser.pseudo;
setInterval(renderCooldowns, 1000);
loadSelectOptions().catch(() => {
    fillSelect(heistTypeSelect, [], 'Aucun type de casse disponible');
    fillSelect(editHeistTypeSelect, [], 'Aucun type de casse disponible');
    fillSelect(drugTypeSelect, [], 'Aucun type de drogue disponible');
    fillSelect(editDrugTypeSelect, [], 'Aucun type de drogue disponible');
});
loadHeists().catch(() => {
    renderHeists([]);
});
