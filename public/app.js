let appState = {
  whatsapp: {},
  settings: { allowedTags: [] },
  chats: [],
  outbox: [],
  contactSaves: [],
  availableLabels: [],
  outboxStats: { pendingApproval: 0, pendingContactApprovals: 0, totalPendingApprovals: 0 },
  auditLogs: [],
  aiClients: []
};

let activeChatTab = 'groups'; // 'groups' | 'contacts'
let selectedMemoryJid = null;
let chatRenderLimit = 100;
let isRefreshingState = false;
let lastTagsKey = '';
let lastChatRenderKey = '';
let lastMemoryKey = '';
let lastConnKey = '';

async function api(path, method = 'GET', body = null) {
  const opts = { method, headers: {} };
  if (body !== null) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(path, opts);
  return res.json();
}

async function refreshState() {
  if (isRefreshingState) return;
  isRefreshingState = true;
  try {
    appState = await api('/api/state');
    renderSidebarAndConnection();
    renderChatsScreen();
    renderApprovalsScreen();
    renderMemorySidebar();
    renderConnectionsScreen();
  } catch (err) {
    console.error(err);
  } finally {
    isRefreshingState = false;
  }
}

function switchView(viewId) {
  document.querySelectorAll('.nav-item').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.view === viewId);
  });
  document.querySelectorAll('.view').forEach((sec) => {
    sec.classList.toggle('active', sec.id === viewId);
  });
  if (viewId === 'view-memory') {
    loadMemoryMessages();
  }
}

function setChatFilterTab(tab) {
  activeChatTab = tab;
  chatRenderLimit = 100;
  lastChatRenderKey = '';
  document.getElementById('segGroups').classList.toggle('active', tab === 'groups');
  document.getElementById('segContacts').classList.toggle('active', tab === 'contacts');
  renderCleanChatList();
}

function showMoreChats() {
  chatRenderLimit += 150;
  lastChatRenderKey = '';
  renderCleanChatList();
}

function onChatSearchInput() {
  chatRenderLimit = 100;
  lastChatRenderKey = '';
  renderCleanChatList();
}

function renderSidebarAndConnection() {
  const { whatsapp, settings, outboxStats } = appState;

  // Master Switch
  const masterCard = document.getElementById('masterCard');
  const chkMaster = document.getElementById('chkMasterAI');
  const masterSub = document.getElementById('masterSub');

  chkMaster.checked = Boolean(settings.aiEnabled);
  if (settings.aiEnabled) {
    masterCard.classList.remove('paused');
    masterSub.textContent = 'Ativo';
  } else {
    masterCard.classList.add('paused');
    masterSub.textContent = 'Pausado';
  }

  // Badge de envios e contatos pendentes
  const badge = document.getElementById('navPendingBadge');
  const totalPending = outboxStats?.totalPendingApprovals ?? outboxStats?.pendingApproval ?? 0;
  if (totalPending > 0) {
    badge.textContent = totalPending;
    badge.classList.remove('hidden');
  } else {
    badge.classList.add('hidden');
  }

  // Rodapé do WhatsApp na Sidebar
  const status = whatsapp?.connectionStatus || 'disconnected';
  const waDot = document.getElementById('waDot');
  const waTitle = document.getElementById('waMiniTitle');
  const waSub = document.getElementById('waMiniSub');
  const btnDisc = document.getElementById('btnSidebarDisconnect');

  if (status === 'connected') {
    waDot.className = 'status-dot connected';
    waTitle.textContent = whatsapp.connectedUser?.name || 'Conectado';
    waSub.textContent = 'WhatsApp ativo';
    btnDisc.classList.remove('hidden');
  } else if (status === 'demo_mode') {
    waDot.className = 'status-dot connected';
    waTitle.textContent = 'Modo Exemplo';
    waSub.textContent = 'Conversas simuladas';
    btnDisc.classList.remove('hidden');
  } else if (status === 'qr_ready' || status === 'connecting') {
    waDot.className = 'status-dot connecting';
    waTitle.textContent = 'Conectando...';
    waSub.textContent = 'Aguardando leitura';
    btnDisc.classList.remove('hidden');
  } else {
    waDot.className = 'status-dot disconnected';
    waTitle.textContent = 'Desconectado';
    waSub.textContent = 'WhatsApp';
    btnDisc.classList.add('hidden');
  }
}

function renderChatsScreen() {
  const wa = appState.whatsapp || {};
  const status = wa.connectionStatus || 'disconnected';
  const onboardingBox = document.getElementById('onboardingBox');
  const connectingBox = document.getElementById('connectingBox');
  const qrBox = document.getElementById('qrBox');
  const connectedBox = document.getElementById('connectedChatsBox');
  const demoBanner = document.getElementById('demoBanner');
  const errEl = document.getElementById('waErrorAlert');

  if (errEl) {
    if (wa.lastError) {
      errEl.textContent = wa.lastError;
      errEl.classList.remove('hidden');
    } else {
      errEl.classList.add('hidden');
    }
  }

  if (status === 'connected' || status === 'demo_mode') {
    onboardingBox.classList.add('hidden');
    connectingBox.classList.add('hidden');
    qrBox.classList.add('hidden');
    connectedBox.classList.remove('hidden');
    if (demoBanner) {
      demoBanner.classList.toggle('hidden', status !== 'demo_mode');
    }

    const syncBar = document.getElementById('historySyncBar');
    const hs = wa.historySyncStatus;
    if (syncBar && hs && (hs.active || (hs.message && Date.now() - (hs.updatedAt || 0) < 15000))) {
      syncBar.textContent = hs.message;
      syncBar.classList.remove('hidden');
    } else if (syncBar) {
      syncBar.classList.add('hidden');
    }

    renderTagsBar();
    renderCleanChatList();
  } else if (status === 'qr_ready' && wa.qrDataUrl) {
    onboardingBox.classList.add('hidden');
    connectingBox.classList.add('hidden');
    connectedBox.classList.add('hidden');
    qrBox.classList.remove('hidden');
    document.getElementById('qrImage').src = wa.qrDataUrl;
  } else if (status === 'connecting') {
    onboardingBox.classList.add('hidden');
    qrBox.classList.add('hidden');
    connectedBox.classList.add('hidden');
    connectingBox.classList.remove('hidden');
    document.getElementById('connectingTitle').textContent =
      wa.pairingMessage || 'Conectando ao WhatsApp...';
  } else {
    connectingBox.classList.add('hidden');
    qrBox.classList.add('hidden');
    connectedBox.classList.add('hidden');
    onboardingBox.classList.remove('hidden');
  }
}

function renderTagsBar() {
  const tags = appState.settings.allowedTags || [];
  const activeQuery = (document.getElementById('chatSearchInput')?.value || '').trim().toLowerCase();
  const nextKey = `${activeQuery}|${tags.join('\u0001')}`;
  if (nextKey === lastTagsKey) return;
  lastTagsKey = nextKey;

  const container = document.getElementById('tagsChips');
  container.innerHTML = tags
    .map((t, idx) => {
      const isFilteringThis = activeQuery && activeQuery === t.toLowerCase();
      return `
      <span class="clean-tag ${isFilteringThis ? 'is-filtering' : ''}">
        <span class="clean-tag-text" onclick="filterByTagChip('${escapeAttr(t)}')" title="Clique para filtrar por esta tag ou lista">${escapeHtml(t)}</span>
        <button onclick="removeTag(${idx})" title="Remover">&times;</button>
      </span>
    `;
    })
    .join('');
}

function filterByTagChip(tagText) {
  const input = document.getElementById('chatSearchInput');
  if (!input) return;
  if (input.value.trim().toLowerCase() === String(tagText || '').trim().toLowerCase()) {
    input.value = '';
  } else {
    input.value = tagText;
  }
  chatRenderLimit = 100;
  lastTagsKey = '';
  lastChatRenderKey = '';
  renderTagsBar();
  renderCleanChatList();
}

function renderCleanChatList() {
  const listEl = document.getElementById('cleanChatList');
  const query = (document.getElementById('chatSearchInput')?.value || '').toLowerCase();
  const queryDigits = query.replace(/\D/g, '');

  let totalGroups = 0;
  let authGroups = 0;
  let totalContacts = 0;
  let authContacts = 0;
  for (const c of appState.chats) {
    if (c.isGroup) {
      totalGroups += 1;
      if (c.isAuthorized) authGroups += 1;
    } else {
      totalContacts += 1;
      if (c.isAuthorized) authContacts += 1;
    }
  }

  const segGroupsEl = document.getElementById('segGroups');
  const segContactsEl = document.getElementById('segContacts');
  const nextGText =
    totalGroups > 0
      ? authGroups > 0
        ? `Grupos (${authGroups} liberados · ${totalGroups})`
        : `Grupos (${totalGroups})`
      : 'Grupos';
  const nextCText =
    totalContacts > 0
      ? authContacts > 0
        ? `Contatos (${authContacts} liberados · ${totalContacts})`
        : `Contatos (${totalContacts})`
      : 'Contatos';
  if (segGroupsEl && segGroupsEl.textContent !== nextGText) segGroupsEl.textContent = nextGText;
  if (segContactsEl && segContactsEl.textContent !== nextCText) segContactsEl.textContent = nextCText;

  const filtered = appState.chats.filter((c) => {
    const matchType = activeChatTab === 'groups' ? c.isGroup : !c.isGroup;
    if (!matchType) return false;
    if (!query) return true;
    const inName = c.name.toLowerCase().includes(query);
    const inLabels = Array.isArray(c.labels) && c.labels.some((l) => l.toLowerCase().includes(query));
    const inDigits = queryDigits.length >= 3 && c.jid.includes(queryDigits);
    return inName || inLabels || inDigits;
  });

  const visible = filtered.slice(0, chatRenderLimit);
  const remaining = Math.max(0, filtered.length - visible.length);

  // Evita reconstruir milhares de elementos DOM a cada 1.5s se nada mudou!
  const renderKey = `${activeChatTab}|${query}|${chatRenderLimit}|${filtered.length}|${Boolean(
    appState.whatsapp?.isSyncingContacts
  )}|${visible
    .map(
      (c) =>
        `${c.jid}:${c.name}:${c.isAuthorized ? 1 : 0}:${c.explicitlyAllowed ? 1 : 0}:${c.storedMessagesCount}:${(
          c.labels || []
        ).join(',')}`
    )
    .join(';')}`;

  if (renderKey === lastChatRenderKey) {
    return;
  }
  lastChatRenderKey = renderKey;

  if (filtered.length === 0) {
    const syncHint =
      activeChatTab === 'contacts' && appState.whatsapp?.isSyncingContacts
        ? 'Sincronizando contatos salvos do seu celular...'
        : 'Nenhuma conversa encontrada nesta aba.';
    listEl.innerHTML = `<div class="empty-calm">${syncHint}</div>`;
    return;
  }

  const rowsHtml = visible
    .map((c) => {
      const countInfo = c.storedMessagesCount > 0 ? ` • ${c.storedMessagesCount} mensagens` : '';
      let subtitle = 'Privado — ignorado pela IA';
      if (c.matchedByLabel) {
        subtitle = `Liberado pela lista "${escapeHtml(c.matchedLabelName || '')}" no WhatsApp${countInfo}`;
      } else if (c.matchedByTag) {
        subtitle = `Liberado pela tag no nome${countInfo}`;
      } else if (c.explicitlyAllowed) {
        subtitle = `Liberado para a IA${countInfo}`;
      }

      const labelsPills =
        Array.isArray(c.labels) && c.labels.length > 0
          ? c.labels.map((lbl) => `<span class="wa-label-pill">${escapeHtml(lbl)}</span>`).join('')
          : '';

      const checked = c.isAuthorized;
      const disabledByTag = c.matchedByTag && !c.explicitlyAllowed;

      return `
        <div class="list-row">
          <div class="row-left">
            <div class="avatar ${checked ? 'active' : ''}">${escapeHtml(getInitials(c.name))}</div>
            <div>
              <div class="row-title-wrap">
                <span class="row-title">${escapeHtml(c.name)}</span>
                ${labelsPills}
              </div>
              <div class="row-sub ${checked ? 'is-active' : ''}">${subtitle}</div>
            </div>
          </div>
          <label class="ios-switch" title="${disabledByTag ? 'Liberado automaticamente por Tag ou Lista' : 'Ligar ou desligar acesso da IA'}">
            <input
              type="checkbox"
              ${checked ? 'checked' : ''}
              ${disabledByTag ? 'disabled' : ''}
              onchange="toggleChatPermission('${escapeAttr(c.jid)}', this.checked)"
            />
            <span class="ios-slider"></span>
          </label>
        </div>
      `;
    })
    .join('');

  const loadMoreHtml =
    remaining > 0
      ? `<div class="load-more-row">
           <button class="btn-ghost btn-xs" onclick="showMoreChats()">Mostrar mais (${remaining} restantes)</button>
         </div>`
      : '';

  listEl.innerHTML = rowsHtml + loadMoreHtml;
}

// --- APROVAÇÕES DE ENVIO E SALVAMENTO DE AGENDA ---
function showApprovalsBanner(text, isError = false) {
  const el = document.getElementById('approvalsNotice');
  if (!el) return;
  el.classList.remove('hidden');
  el.style.background = isError ? 'var(--danger-soft)' : 'var(--accent-soft)';
  el.style.color = isError ? '#b91c1c' : 'var(--accent-hover)';
  el.innerHTML = `<span>${escapeHtml(text)}</span><button class="btn-ghost btn-xs" onclick="document.getElementById('approvalsNotice').classList.add('hidden')">Fechar</button>`;
}

function renderApprovalsScreen() {
  const contactsBox = document.getElementById('contactApprovalsSection');
  const container = document.getElementById('approvalsList');
  const items = appState.outbox || [];
  const contactItems = appState.contactSaves || [];

  // Não reconstrói enquanto o usuário está digitando num campo editável
  if (
    document.activeElement &&
    (document.activeElement.classList.contains('approval-textarea') ||
      document.activeElement.classList.contains('contact-name-input'))
  ) {
    return;
  }

  if (items.length === 0 && contactItems.length === 0) {
    if (contactsBox) contactsBox.innerHTML = '';
    container.innerHTML = `
      <div class="empty-calm">
        Nenhuma mensagem ou contato pendente no momento.<br/>
        Quando a IA preparar uma mensagem ou sugerir salvar contatos na agenda do celular, eles aparecerão aqui.
      </div>
    `;
    return;
  }

  // 1) Seção de Contatos preparados pela IA para a Agenda (WhatsApp + Celular)
  if (contactsBox) {
    if (contactItems.length === 0) {
      contactsBox.innerHTML = '';
    } else {
      const pendingContacts = contactItems.filter((c) => c.status === 'pending_approval');
      const contactStatusMap = {
        pending_approval: { text: 'Aguardando salvar na agenda', cls: 'pending' },
        saved: { text: 'Salvo no WhatsApp + Celular', cls: 'sent' },
        rejected: { text: 'Recusado', cls: '' },
        failed: { text: 'Falha ao gravar', cls: 'failed' }
      };

      const batchBarHtml =
        pendingContacts.length >= 2
          ? `<div class="batch-approve-bar">
               <div>
                 <strong>${pendingContacts.length} contatos prontos para salvar na sua agenda</strong>
                 <span>Grava no WhatsApp Web, no WhatsApp do celular e na agenda do aparelho.</span>
               </div>
               <div class="batch-approve-actions">
                 <button class="btn-primary btn-sm" id="btnApproveAllContacts" onclick="approveAllContactSaves()">
                   Aprovar todos (${pendingContacts.length})
                 </button>
                 <button class="btn-ghost btn-sm" onclick="rejectAllContactSaves()">Recusar todos</button>
               </div>
             </div>`
          : '';

      const cardsHtml = contactItems
        .map((c) => {
          const st = contactStatusMap[c.status] || { text: c.status, cls: '' };
          const isPending = c.status === 'pending_approval' || c.status === 'failed';
          const isFailed = c.status === 'failed';
          const labelsPills =
            Array.isArray(c.labels) && c.labels.length > 0
              ? c.labels.map((lbl) => `<span class="wa-label-pill">${escapeHtml(lbl)}</span>`).join('')
              : '';
          const prevHint =
            c.previous_name && c.previous_name !== c.displayPhone && c.previous_name !== c.full_name
              ? `<span class="contact-prev-hint">Antes: ${escapeHtml(c.previous_name)}</span>`
              : '';
          const reasonHint =
            c.reason && (c.status === 'failed' || c.reason.toLowerCase().includes('desconectado'))
              ? `<div class="contact-reason-warn">${escapeHtml(c.reason)}</div>`
              : '';

          return `
            <div class="approval-card contact-save-card ${isPending ? 'pending' : ''}">
              <div class="approval-top">
                <div class="contact-card-meta">
                  <strong>Agenda: ${escapeHtml(c.displayPhone || c.jid)}</strong>
                  ${prevHint}
                  ${labelsPills}
                </div>
                <span class="status-chip ${st.cls}">${st.text}</span>
              </div>
              ${
                isPending
                  ? `<div class="contact-edit-row">
                       <input
                         type="text"
                         id="edit_contact_name_${c.id}"
                         class="contact-name-input"
                         value="${escapeHtml(c.full_name)}"
                         placeholder="Nome completo na agenda"
                       />
                       <div class="approval-actions contact-inline-actions">
                         <button class="btn-primary btn-sm" id="btn_save_contact_${c.id}" onclick="approveContactSaveItem(${c.id})">
                           ${isFailed ? 'Tentar novamente' : 'Salvar na agenda'}
                         </button>
                         <button class="btn-ghost btn-sm" onclick="rejectContactSaveItem(${c.id})">Recusar</button>
                       </div>
                     </div>
                     ${reasonHint}`
                  : `<div class="bubble-text"><strong>${escapeHtml(c.full_name)}</strong></div>${reasonHint}`
              }
            </div>
          `;
        })
        .join('');

      contactsBox.innerHTML = `
        <div class="sub-header approvals-sub-header">
          <h2>Contatos na Agenda (${contactItems.length})</h2>
        </div>
        ${batchBarHtml}
        <div class="approvals-stack" style="margin-bottom: 22px;">${cardsHtml}</div>
      `;
    }
  }

  // 2) Seção de Mensagens da IA
  if (items.length === 0) {
    container.innerHTML = '';
    return;
  }

  const labelMap = {
    pending_approval: { text: 'Aguardando sua aprovação', cls: 'pending' },
    queued: { text: 'Na fila segura', cls: '' },
    sending_typing: { text: 'Digitando no WhatsApp...', cls: '' },
    sent: { text: 'Enviada', cls: 'sent' },
    rejected: { text: 'Descartada', cls: '' },
    failed: { text: 'Não enviada', cls: 'failed' }
  };

  const msgHeader =
    contactItems.length > 0
      ? `<div class="sub-header approvals-sub-header"><h2>Mensagens da IA (${items.length})</h2></div>`
      : '';

  container.innerHTML =
    msgHeader +
    items
      .map((item) => {
        const st = labelMap[item.status] || { text: item.status, cls: '' };
        const isPending = item.status === 'pending_approval';
        let chipText = st.text;
        if (item.status === 'queued' && item.reason) {
          const m = String(item.reason).match(/~?(\d+)s/);
          if (m) {
            chipText = `Na fila segura · ~${m[1]}s`;
          }
        }

        return `
          <div class="approval-card ${isPending ? 'pending' : ''}">
            <div class="approval-top">
              <strong>Para: ${escapeHtml(item.chat_name)}</strong>
              <span class="status-chip ${st.cls}">${escapeHtml(chipText)}</span>
            </div>
            ${
              isPending
                ? `<textarea id="edit_outbox_${item.id}" class="approval-textarea">${escapeHtml(item.content)}</textarea>
                   <div class="approval-actions">
                     <button class="btn-primary btn-sm" onclick="approveOutbox(${item.id})">Aprovar e enviar</button>
                     <button class="btn-ghost btn-sm" onclick="rejectOutbox(${item.id})">Descartar</button>
                   </div>`
                : `<div class="bubble-text">${escapeHtml(item.content)}</div>`
            }
          </div>
        `;
      })
      .join('');
}

// --- MEMÓRIA DA IA ---
function renderMemorySidebar() {
  const sidebar = document.getElementById('memorySidebar');
  const authorized = appState.chats.filter((c) => c.isAuthorized);

  if (authorized.length === 0) {
    if (lastMemoryKey !== 'empty') {
      lastMemoryKey = 'empty';
      sidebar.innerHTML = `<div style="padding:18px;font-size:12.5px;color:#6b7280;">Nenhuma conversa liberada.</div>`;
    }
    return;
  }

  if (!selectedMemoryJid || !authorized.some((c) => c.jid === selectedMemoryJid)) {
    selectedMemoryJid = authorized[0].jid;
    loadMemoryMessages();
  }

  const memKey = `${selectedMemoryJid}|${authorized
    .map((c) => `${c.jid}:${c.name}:${c.storedMessagesCount}`)
    .join(';')}`;
  if (memKey === lastMemoryKey) return;
  lastMemoryKey = memKey;

  sidebar.innerHTML = authorized
    .map(
      (c) => `
      <button
        class="mem-chat-item ${c.jid === selectedMemoryJid ? 'selected' : ''}"
        onclick="selectMemoryChat('${escapeAttr(c.jid)}')"
      >
        <span class="mem-chat-name">${escapeHtml(c.name)}</span>
        <span class="mem-chat-count">${c.storedMessagesCount}</span>
      </button>
    `
    )
    .join('');
}

function selectMemoryChat(jid) {
  selectedMemoryJid = jid;
  renderMemorySidebar();
  loadMemoryMessages();
}

async function loadMemoryMessages() {
  const box = document.getElementById('memoryMessages');
  const titleEl = document.getElementById('memoryChatTitle');
  if (!selectedMemoryJid) return;

  const chat = appState.chats.find((c) => c.jid === selectedMemoryJid);
  titleEl.textContent = chat ? chat.name : 'Conversa';

  const data = await api(`/api/messages?jid=${encodeURIComponent(selectedMemoryJid)}`);
  const msgs = data.messages || [];

  if (msgs.length === 0) {
    box.innerHTML = `<div class="empty-calm" style="background:transparent;border:none;">Nenhuma mensagem salva nesta conversa.</div>`;
    return;
  }

  box.innerHTML = msgs
    .map(
      (m) => `
      <div class="clean-bubble">
        <div>
          <div class="bubble-sender">${escapeHtml(m.sender_name)}</div>
          <div class="bubble-text">${escapeHtml(m.content)}</div>
          <div class="bubble-time">${new Date(m.timestamp).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}</div>
        </div>
        <button class="bubble-del" onclick="deleteSingleMessage('${escapeAttr(m.id)}')" title="Remover da memória da IA">
          Remover
        </button>
      </div>
    `
    )
    .join('');
}

async function syncContacts() {
  const btn = document.getElementById('btnSyncContacts');
  const syncBar = document.getElementById('historySyncBar');
  if (btn) btn.disabled = true;
  if (syncBar) {
    syncBar.textContent = 'Sincronizando contatos salvos e listas do WhatsApp...';
    syncBar.classList.remove('hidden');
  }
  try {
    const res = await api('/api/whatsapp/sync-contacts', 'POST', {});
    if (syncBar && res?.message) {
      syncBar.textContent = res.message;
      syncBar.classList.remove('hidden');
    }
    await refreshState();
  } finally {
    if (btn) btn.disabled = false;
  }
}

async function pullHistory(jid = null) {
  const btnAll = document.getElementById('btnPullAllHistory');
  const btnChat = document.getElementById('btnPullChatHistory');
  const syncBar = document.getElementById('historySyncBar');

  if (btnAll) btnAll.disabled = true;
  if (btnChat) {
    btnChat.disabled = true;
    btnChat.textContent = 'Buscando...';
  }
  if (syncBar) {
    syncBar.textContent = 'Buscando mensagens anteriores no celular...';
    syncBar.classList.remove('hidden');
  }

  try {
    const res = await api('/api/whatsapp/fetch-history', 'POST', { jid, count: 50 });
    if (syncBar && res?.message) {
      syncBar.textContent = res.message;
      syncBar.classList.remove('hidden');
    }
    await refreshState();
    if (selectedMemoryJid) {
      await loadMemoryMessages();
    }
  } finally {
    if (btnAll) btnAll.disabled = false;
    if (btnChat) {
      btnChat.disabled = false;
      btnChat.textContent = 'Carregar anteriores';
    }
  }
}

// --- CONEXÕES COM IAS & AJUSTES ---
let showUndetectedAis = false;
let customTunnelInputsHydrated = false;

function renderConnectionsScreen() {
  const clientsEl = document.getElementById('aiClientsCleanList');
  const otherWrap = document.getElementById('otherAiToggleWrap');
  const btnOther = document.getElementById('btnToggleOtherAis');
  const clients = appState.aiClients || [];

  const detectedClients = clients.filter((c) => c.detected || c.configured);
  const undetectedClients = clients.filter((c) => !c.detected && !c.configured);
  const visibleClients =
    showUndetectedAis || detectedClients.length === 0 ? clients : detectedClients;

  const connRenderKey = JSON.stringify({
    showUndetectedAis,
    clients: visibleClients.map((c) => [c.id, c.configured, c.detected, c.recentlyActivated])
  });

  if (connRenderKey !== lastConnKey) {
    lastConnKey = connRenderKey;
    clientsEl.innerHTML = visibleClients
      .map((c) => {
        const badgeText = c.badge || c.name.slice(0, 2).toUpperCase();
        const subText = c.configured
          ? c.recentlyActivated && c.reloadHint
            ? `Conectado ao Guardião · ${c.reloadHint}`
            : `Conectado ao Guardião · ${c.description || ''}`
          : c.detected
          ? c.description || 'Instalado neste computador · Desconectado'
          : `${c.description || 'Compatível'} · Não detectado neste PC`;

        const restartBtnHtml =
          c.configured && c.canRestart
            ? `<button class="btn-ghost btn-xs" onclick="restartClientApp('${escapeAttr(c.id)}')" title="Fechar por completo e reabrir para carregar o MCP">Reiniciar app</button>`
            : '';

        return `
      <div class="list-row">
        <div class="row-left">
          <div class="avatar ${c.configured ? 'active' : ''}">${escapeHtml(badgeText)}</div>
          <div>
            <div class="row-title">${escapeHtml(c.name)}</div>
            <div class="row-sub ${c.configured ? 'is-active' : ''}">
              ${escapeHtml(subText)}
            </div>
          </div>
        </div>
        <div class="row-right-inline">
          ${restartBtnHtml}
          <label class="ios-switch">
            <input
              type="checkbox"
              ${c.configured ? 'checked' : ''}
              onchange="toggleAIClient('${escapeAttr(c.id)}', this.checked)"
            />
            <span class="ios-slider"></span>
          </label>
        </div>
      </div>
    `;
      })
      .join('');
  }

  if (undetectedClients.length > 0 && detectedClients.length > 0) {
    otherWrap.classList.remove('hidden');
    btnOther.textContent = showUndetectedAis
      ? 'Ocultar IAs não instaladas neste PC'
      : `Mostrar outras IAs compatíveis (${undetectedClients.length})`;
  } else {
    otherWrap.classList.add('hidden');
  }

  renderWebTunnelSection();

  // Switches de proteção
  const s = appState.settings;
  document.getElementById('chkApproveContacts').checked = Boolean(s.requireApprovalForContacts);
  document.getElementById('chkApproveGroups').checked = Boolean(s.requireApprovalForGroups);
  const chkSaveContacts = document.getElementById('chkApproveContactSaves');
  if (chkSaveContacts) {
    chkSaveContacts.checked = s.requireApprovalForContactsSave !== false;
  }
  document.getElementById('chkSimulateTyping').checked = Boolean(s.simulateTyping);

  // Últimos acessos
  const auditEl = document.getElementById('cleanAuditList');
  const logs = (appState.auditLogs || []).slice(0, 8);
  if (logs.length === 0) {
    auditEl.innerHTML = `<div class="empty-calm" style="border:none;">Nenhum acesso realizado pela IA ainda.</div>`;
  } else {
    auditEl.innerHTML = logs
      .map(
        (l) => `
        <div class="audit-row ${l.blocked ? 'is-blocked' : ''}">
          <span>${escapeHtml(l.details || l.action)}</span>
          <span class="audit-time">${new Date(l.timestamp).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}</span>
        </div>
      `
      )
      .join('');
  }
}

function renderWebTunnelSection() {
  const t = appState.tunnel || {};
  const chk = document.getElementById('chkWebTunnel');
  const body = document.getElementById('webTunnelBody');
  const statusLine = document.getElementById('webTunnelStatusLine');
  const urlBox = document.getElementById('webTunnelUrlBox');
  const urlInput = document.getElementById('webTunnelUrlInput');

  if (!chk || !body) return;

  const isActiveOrBusy =
    Boolean(t.enabled) ||
    t.status === 'running' ||
    t.status === 'starting' ||
    t.status === 'downloading';

  chk.checked = isActiveOrBusy;
  body.classList.toggle('hidden', !isActiveOrBusy && t.status !== 'error');

  if (t.status === 'downloading') {
    statusLine.className = 'tunnel-status-line pending';
    statusLine.textContent = 'Baixando conector seguro da Cloudflare pela primeira vez...';
    urlBox.classList.add('hidden');
  } else if (t.status === 'starting') {
    statusLine.className = 'tunnel-status-line pending';
    statusLine.textContent = 'Abrindo túnel criptografado HTTPS...';
    urlBox.classList.add('hidden');
  } else if (t.status === 'running' && t.publicMcpUrl) {
    statusLine.className = 'tunnel-status-line online';
    statusLine.textContent =
      t.mode === 'custom'
        ? '● Link fixo HTTPS ativo e protegido por token secreto'
        : '● Link seguro HTTPS ativo — copie e cole no SuperGrok / Grok Bot / Gemini Web';
    urlBox.classList.remove('hidden');
    if (document.activeElement !== urlInput) {
      urlInput.value = t.publicMcpUrl;
    }
  } else if (t.status === 'error') {
    statusLine.className = 'tunnel-status-line error';
    statusLine.textContent = `Não foi possível abrir o túnel: ${t.lastError || 'verifique sua internet'}`;
    urlBox.classList.add('hidden');
  } else {
    statusLine.className = 'tunnel-status-line';
    statusLine.textContent = '';
    urlBox.classList.add('hidden');
  }

  if (!customTunnelInputsHydrated && appState.settings) {
    const inpUrl = document.getElementById('inpCustomTunnelUrl');
    if (inpUrl && appState.settings.customTunnelUrl) {
      inpUrl.value = appState.settings.customTunnelUrl;
    }
    customTunnelInputsHydrated = true;
  }
}

function toggleShowOtherAis() {
  showUndetectedAis = !showUndetectedAis;
  lastConnKey = '';
  renderConnectionsScreen();
}

function showMcpDiagBanner(text, isError = false) {
  const el = document.getElementById('mcpDiagNotice');
  if (!el) return;
  el.classList.remove('hidden');
  el.style.background = isError ? 'var(--danger-soft)' : 'var(--accent-soft)';
  el.style.color = isError ? '#b91c1c' : 'var(--accent-hover)';
  el.innerHTML = `<span>${escapeHtml(text)}</span><button class="btn-ghost btn-xs" onclick="document.getElementById('mcpDiagNotice').classList.add('hidden')">Fechar</button>`;
}

async function runMcpSelfTest() {
  const btn = document.getElementById('btnTestMcp');
  if (btn) {
    btn.disabled = true;
    btn.textContent = 'Testando...';
  }
  try {
    const res = await api('/api/ai-clients/test', 'POST', {});
    if (res.ok) {
      showMcpDiagBanner(
        `✓ Ponte MCP funcionando perfeitamente (${res.toolsCount} ferramentas ativas em ${res.latencyMs}ms · modo ${res.mode}).`
      );
    } else {
      showMcpDiagBanner(`Falha no autoteste MCP: ${res.error || 'erro desconhecido'}`, true);
    }
  } catch (err) {
    showMcpDiagBanner(`Erro ao testar conexão: ${err.message}`, true);
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = 'Testar conexão';
    }
  }
}

async function restartClientApp(clientId) {
  showMcpDiagBanner('Reiniciando aplicativo para carregar o MCP...');
  const res = await api('/api/ai-clients/restart', 'POST', { clientId });
  lastConnKey = '';
  await refreshState();
  showMcpDiagBanner(res.message || 'Aplicativo reiniciado.', !res.ok);
}

async function toggleWebTunnel(enabled) {
  const statusLine = document.getElementById('webTunnelStatusLine');
  const body = document.getElementById('webTunnelBody');
  if (enabled && body && statusLine) {
    body.classList.remove('hidden');
    statusLine.className = 'tunnel-status-line pending';
    statusLine.textContent = 'Iniciando link seguro HTTPS (pode levar alguns segundos)...';
  }
  await api('/api/tunnel/toggle', 'POST', { enabled });
  await refreshState();
}

async function copyTunnelUrl() {
  const input = document.getElementById('webTunnelUrlInput');
  const btn = document.getElementById('btnCopyTunnelUrl');
  if (!input || !input.value) return;
  try {
    await navigator.clipboard.writeText(input.value);
    if (btn) {
      const prev = btn.textContent;
      btn.textContent = 'Copiado!';
      setTimeout(() => {
        btn.textContent = prev;
      }, 1800);
    }
  } catch {
    input.select();
    document.execCommand('copy');
  }
}

async function rotateWebToken() {
  await api('/api/tunnel/rotate-token', 'POST', {});
  await refreshState();
  showMcpDiagBanner('Nova chave secreta gerada! Atualize a URL nos conectores Web que você usa.');
}

function toggleCustomTunnelPanel() {
  const panel = document.getElementById('customTunnelPanel');
  if (panel) panel.classList.toggle('hidden');
}

async function saveCustomTunnelConfig() {
  const customTunnelUrl = document.getElementById('inpCustomTunnelUrl')?.value || '';
  const customTunnelToken = document.getElementById('inpCustomTunnelToken')?.value || '';
  await api('/api/tunnel/config', 'POST', { customTunnelUrl, customTunnelToken });
  await refreshState();
  showMcpDiagBanner('Configuração de túnel fixo salva.');
}

async function clearCustomTunnelConfig() {
  const inpUrl = document.getElementById('inpCustomTunnelUrl');
  const inpTok = document.getElementById('inpCustomTunnelToken');
  if (inpUrl) inpUrl.value = '';
  if (inpTok) inpTok.value = '';
  await api('/api/tunnel/config', 'POST', { customTunnelUrl: '', customTunnelToken: '' });
  await refreshState();
  showMcpDiagBanner('Voltamos para o link automático gratuito da Cloudflare.');
}

async function openExternalUrl(url) {
  await api('/api/open-external', 'POST', { url });
}

// --- AÇÕES ---
async function toggleMasterAI(enabled) {
  await api('/api/settings', 'POST', { aiEnabled: enabled });
  await refreshState();
}

async function connectWhatsApp(forceFresh = true) {
  await api('/api/whatsapp/connect', 'POST', { forceFresh });
  await refreshState();
}

async function activateDemoMode() {
  await api('/api/whatsapp/demo', 'POST');
  await refreshState();
}

async function disconnectWhatsApp(logout = false) {
  await api('/api/whatsapp/disconnect', 'POST', { logout });
  await refreshState();
}

async function toggleChatPermission(jid, allowed) {
  await api('/api/chats/permission', 'POST', { jid, allowed });
  await refreshState();
}

async function addTag() {
  const input = document.getElementById('newTagInput');
  const val = input.value.trim();
  if (!val) return;
  const current = appState.settings.allowedTags || [];
  if (!current.includes(val)) {
    await api('/api/settings', 'POST', { allowedTags: [...current, val] });
  }
  input.value = '';
  await refreshState();
}

async function removeTag(idx) {
  const current = [...(appState.settings.allowedTags || [])];
  current.splice(idx, 1);
  await api('/api/settings', 'POST', { allowedTags: current });
  await refreshState();
}

async function approveOutbox(id) {
  const el = document.getElementById(`edit_outbox_${id}`);
  await api('/api/outbox/approve', 'POST', { id, content: el ? el.value : null });
  await refreshState();
}

async function rejectOutbox(id) {
  await api('/api/outbox/reject', 'POST', { id });
  await refreshState();
}

async function approveContactSaveItem(id) {
  const btn = document.getElementById(`btn_save_contact_${id}`);
  const inp = document.getElementById(`edit_contact_name_${id}`);
  if (btn) {
    btn.disabled = true;
    btn.textContent = 'Salvando...';
  }
  try {
    const res = await api('/api/contacts-queue/approve', 'POST', {
      id,
      fullName: inp ? inp.value : null
    });
    if (!res.ok) {
      showApprovalsBanner(res.error || 'Não foi possível salvar o contato agora.', true);
    } else {
      showApprovalsBanner('Contato salvo com sucesso na agenda do WhatsApp e do celular!');
      lastChatRenderKey = '';
    }
    await refreshState();
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = 'Salvar na agenda';
    }
  }
}

async function rejectContactSaveItem(id) {
  await api('/api/contacts-queue/reject', 'POST', { id });
  await refreshState();
}

async function approveAllContactSaves() {
  const btn = document.getElementById('btnApproveAllContacts');
  if (btn) {
    btn.disabled = true;
    btn.textContent = 'Salvando todos no celular...';
  }
  try {
    const res = await api('/api/contacts-queue/approve', 'POST', { all: true });
    if (res.message) {
      showApprovalsBanner(res.message, !res.ok || res.failedCount > 0);
    }
    lastChatRenderKey = '';
    await refreshState();
  } finally {
    if (btn) btn.disabled = false;
  }
}

async function rejectAllContactSaves() {
  await api('/api/contacts-queue/reject', 'POST', { all: true });
  await refreshState();
}

async function deleteSingleMessage(id) {
  await api('/api/messages/delete', 'POST', { id });
  await loadMemoryMessages();
  await refreshState();
}

async function clearSelectedChatHistory(lastHoursOnly = null) {
  if (!selectedMemoryJid) return;
  await api('/api/messages/clear', 'POST', { jid: selectedMemoryJid, lastHoursOnly });
  await loadMemoryMessages();
  await refreshState();
}

async function toggleAIClient(clientId, enabled) {
  if (enabled) {
    await api('/api/ai-clients/install', 'POST', { clientId });
  } else {
    await api('/api/ai-clients/uninstall', 'POST', { clientId });
  }
  lastConnKey = '';
  await refreshState();
}

async function installInAllClients() {
  await api('/api/ai-clients/install', 'POST', { all: true });
  lastConnKey = '';
  await refreshState();
  showMcpDiagBanner('✓ Conectado automaticamente em todos os aplicativos de IA detectados neste computador!');
}

async function saveAntiBanSettings() {
  const sim = document.getElementById('chkSimulateTyping').checked;
  const chkSaveContacts = document.getElementById('chkApproveContactSaves');
  await api('/api/settings', 'POST', {
    requireApprovalForContacts: document.getElementById('chkApproveContacts').checked,
    requireApprovalForGroups: document.getElementById('chkApproveGroups').checked,
    requireApprovalForContactsSave: chkSaveContacts ? chkSaveContacts.checked : true,
    simulateTyping: sim,
    blockDuplicateMessages: sim
  });
  await refreshState();
}

function getInitials(name) {
  const str = String(name || '').trim();
  if (str.startsWith('+')) {
    const brMatch = str.match(/^\+55\s+(\d{2})\b/);
    if (brMatch) return brMatch[1];
    const digits = str.replace(/\D/g, '');
    return digits.slice(-2) || '#';
  }
  const words = str
    .replace(/\[.*?\]|#\S+/g, '')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (words.length === 0) return 'WA';
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return (words[0][0] + words[1][0]).toUpperCase();
}

function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function escapeAttr(str) {
  return String(str ?? '').replace(/'/g, "\\'");
}

async function openLogFile() {
  await api('/api/logs/open', 'POST', {});
}

refreshState();
setInterval(refreshState, 1500);
