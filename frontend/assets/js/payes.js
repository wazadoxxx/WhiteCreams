const API_BASE_URL = 'http://localhost:3000';

const authToken = localStorage.getItem('authToken');
const authUserRaw = localStorage.getItem('authUser');
const connectedUser = authUserRaw ? JSON.parse(authUserRaw) : null;
const logoutButton = document.getElementById('logoutButton');
const teamHeistsBody = document.getElementById('teamHeistsBody');
const openTeamHeistModalButton = document.getElementById('openTeamHeistModal');
const teamHeistModal = document.getElementById('teamHeistModal');
const teamHeistForm = document.getElementById('teamHeistForm');
const teamHeistTypeSelect = document.getElementById('teamHeistType');
const teamHeistGainInput = document.getElementById('teamHeistGain');
const teamHeistWeaponField = document.getElementById('teamHeistWeaponField');
const teamHeistWeaponSelect = document.getElementById('teamHeistWeapon');
const teamHeistParticipantsEl = document.getElementById('teamHeistParticipants');
const TEAM_HEIST_TYPE_LABELS = {
    Armurie: 'armurie',
    'Fleeca Bank': 'fleeca-bank'
};
const ARMURIE_WEAPON_OPTIONS = ['Lampe Torche', 'Club De Golf', 'Couteau', 'Pied de biche', 'Marteau'];

let teamHeistLimitState = {
    windowDays: 7,
    maxPerWindow: 2,
    byType: []
};

if (!authToken || !authUserRaw) {
    window.location.href = 'login.html';
    throw new Error('Utilisateur non connecte');
}

function getNowIsoDateTime() {
    return new Date().toISOString();
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

    if (teamHeistModal) {
        teamHeistModal.addEventListener('click', (event) => {
            if (event.target === teamHeistModal) {
                closeModal(teamHeistModal);
            }
        });
    }
}

function fillParticipants(values) {
    teamHeistParticipantsEl.innerHTML = '';

    if (!values.length) {
        const emptyState = document.createElement('p');
        emptyState.className = 'auto-date-note';
        emptyState.textContent = 'Aucun participant disponible';
        teamHeistParticipantsEl.appendChild(emptyState);
        return;
    }

    values.forEach((value, index) => {
        const wrapper = document.createElement('label');
        wrapper.className = 'participant-option';

        const input = document.createElement('input');
        input.type = 'checkbox';
        input.value = value;
        input.id = `team-participant-${index}`;

        const text = document.createElement('span');
        text.textContent = value;

        wrapper.appendChild(input);
        wrapper.appendChild(text);
        teamHeistParticipantsEl.appendChild(wrapper);
    });
}

function getSelectedParticipants() {
    return Array.from(teamHeistParticipantsEl.querySelectorAll('input[type="checkbox"]:checked')).map((input) => input.value);
}

function updateWeaponFieldVisibility() {
    if (!teamHeistTypeSelect || !teamHeistWeaponField || !teamHeistWeaponSelect) {
        return;
    }

    const isArmurie = teamHeistTypeSelect.value === 'Armurie';
    teamHeistWeaponField.classList.toggle('hidden', !isArmurie);
    teamHeistWeaponSelect.required = isArmurie;

    if (!isArmurie) {
        teamHeistWeaponSelect.value = '';
    }
}

async function loadParticipantsOptions() {
    const response = await fetch(`${API_BASE_URL}/api/casses-options`);
    const data = await response.json();

    if (!response.ok || !data.ok) {
        throw new Error(data.error || 'Erreur chargement des participants');
    }

    const users = (data.users || []).filter((pseudo) => pseudo !== connectedUser?.pseudo);
    fillParticipants(users);
}

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

function getTeamHeistLimitByType(type) {
    return (teamHeistLimitState.byType || []).find((item) => item.type === type) || null;
}

function buildSlotLine(slotData, slotLabel) {
    if (!slotData || !slotData.startedAt || !slotData.lockedUntil) {
        return `${slotLabel}: en attente`;
    }

    const unlockAtMs = Date.parse(slotData.lockedUntil);
    if (Number.isNaN(unlockAtMs)) {
        return `${slotLabel}: en attente`;
    }

    if (unlockAtMs > Date.now()) {
        return `${slotLabel}: actif jusqu'au ${formatDate(slotData.lockedUntil)}`;
    }

    return `${slotLabel}: termine`;
}

function renderTeamHeistCounters() {
    const maxPerWindow = Number(teamHeistLimitState.maxPerWindow || 2);

    Object.entries(TEAM_HEIST_TYPE_LABELS).forEach(([type, slug]) => {
        const limit = getTeamHeistLimitByType(type);
        const mainEl = document.getElementById(`quota-main-${slug}`);
        const noteEl = document.getElementById(`quota-note-${slug}`);
        const cardEl = document.querySelector(`[data-team-heist-type="${type}"]`);

        if (!mainEl || !noteEl || !cardEl) {
            return;
        }

        const usedCount = limit ? Number(limit.countInWindow || 0) : 0;
        const displayedCount = Math.min(maxPerWindow, Math.max(0, usedCount));
        const remainingCount = limit ? Number(limit.remaining || 0) : maxPerWindow;
        const slotCooldowns = Array.isArray(limit?.slotCooldowns) ? limit.slotCooldowns : [];
        const slot1Line = buildSlotLine(slotCooldowns[0], 'Delai 1');
        const slot2Line = buildSlotLine(slotCooldowns[1], 'Delai 2');
        mainEl.textContent = `${displayedCount}/${maxPerWindow}`;

        if (limit && limit.isLocked) {
            const lockDateText = limit.lockedUntil ? formatDate(limit.lockedUntil) : `dans ${teamHeistLimitState.windowDays || 7} jours`;
            noteEl.textContent = `${slot1Line}\n${slot2Line}\nLimite atteinte. Dispo le ${lockDateText}`;
            cardEl.classList.add('is-locked');
            cardEl.classList.remove('is-ready');
            return;
        }

        noteEl.textContent = `${slot1Line}\n${slot2Line}\n${remainingCount} restant(s) sur ${teamHeistLimitState.windowDays || 7} jours`;
        cardEl.classList.remove('is-locked');
        cardEl.classList.add('is-ready');
    });
}

function renderTable(rows) {
    teamHeistsBody.innerHTML = '';

    rows.forEach((item) => {
        const tr = document.createElement('tr');
        const participants = (item.participants || []).length ? item.participants.join(', ') : '-';
        const weapon = item.type === 'Armurie' ? (item.weapon || '-') : '-';

        tr.innerHTML = `
            <td>${formatDate(item.date)}</td>
            <td>${item.pseudo}</td>
            <td>${item.type}</td>
            <td>${weapon}</td>
            <td>${item.moneyType || 'Sale'}</td>
            <td>${participants}</td>
            <td>${formatMoney(item.gain)}</td>
        `;

        teamHeistsBody.appendChild(tr);
    });

    if (!rows.length) {
        const tr = document.createElement('tr');
        tr.innerHTML = '<td colspan="7">Aucune Armurie/Fleeca enregistree pour le moment.</td>';
        teamHeistsBody.appendChild(tr);
    }
}

async function loadTeamHeists() {
    const response = await fetch(`${API_BASE_URL}/api/team-heists`);
    const data = await response.json();

    if (!response.ok || !data.ok) {
        throw new Error(data.error || 'Erreur chargement des casses equipe');
    }

    teamHeistLimitState = {
        windowDays: Number(data?.limits?.windowDays || 7),
        maxPerWindow: Number(data?.limits?.maxPerWindow || 2),
        byType: Array.isArray(data?.limits?.byType) ? data.limits.byType : []
    };

    renderTeamHeistCounters();
    renderTable(data.heists || []);
}

async function submitTeamHeist(event) {
    event.preventDefault();

    const type = teamHeistTypeSelect.value;
    const gain = Number(teamHeistGainInput.value || 0);
    const weapon = type === 'Armurie' ? String(teamHeistWeaponSelect?.value || '').trim() : null;
    const participants = getSelectedParticipants();
    const date = getNowIsoDateTime();
    const selectedTypeLimit = getTeamHeistLimitByType(type);

    if (selectedTypeLimit && selectedTypeLimit.isLocked) {
        const lockDateText = selectedTypeLimit.lockedUntil ? formatDate(selectedTypeLimit.lockedUntil) : `dans ${teamHeistLimitState.windowDays || 7} jours`;
        throw new Error(`${type} bloque: limite atteinte. Reessayez le ${lockDateText}.`);
    }

    if (!participants.length) {
        throw new Error('Selectionne au moins 1 participant.');
    }

    if (type === 'Armurie' && !ARMURIE_WEAPON_OPTIONS.includes(weapon)) {
        throw new Error('Selectionne une arme gagnee pour Armurie.');
    }

    const response = await fetch(`${API_BASE_URL}/api/casses/${encodeURIComponent(connectedUser.pseudo)}/heists`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type, gain, date, participants, weapon })
    });

    const data = await response.json();
    if (!response.ok || !data.ok) {
        throw new Error(data.error || 'Erreur ajout casse equipe');
    }

    teamHeistForm.reset();
    updateWeaponFieldVisibility();
    closeModal(teamHeistModal);
    await loadTeamHeists();
}

if (openTeamHeistModalButton) {
    openTeamHeistModalButton.addEventListener('click', () => {
        openModal(teamHeistModal);
    });
}

if (teamHeistForm) {
    teamHeistForm.addEventListener('submit', (event) => {
        submitTeamHeist(event).catch((error) => alert(error.message));
    });
}

if (teamHeistTypeSelect) {
    teamHeistTypeSelect.addEventListener('change', () => {
        updateWeaponFieldVisibility();
    });
}

logoutButton.addEventListener('click', () => {
    localStorage.removeItem('authToken');
    localStorage.removeItem('authUser');
    window.location.href = 'login.html';
});

wireModalCloseButtons();
updateWeaponFieldVisibility();
loadParticipantsOptions().catch(() => {
    fillParticipants([]);
});

loadTeamHeists().catch(() => {
    renderTable([]);
});
