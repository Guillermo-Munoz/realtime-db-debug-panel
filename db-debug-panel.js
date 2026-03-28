/**
 * db-debug-panel.js (versión mejorada)
 *
 * Panel de depuración genérico e inyectable para monitorización en tiempo real
 * de cualquier tabla a través del endpoint db-debug.php.
 *
 * El panel es completamente dinámico: las columnas se renderizan a partir de
 * los metadatos devueltos por el endpoint, sin necesidad de configuración
 * adicional al cambiar de tabla.
 *
 * Ahora también soporta cambiar los parámetros de conexión a la base de datos
 * desde el panel (host, usuario, contraseña, base de datos).
 *
 * Configuración (objeto CONFIG al inicio del IIFE):
 *   endpoint  — URL del endpoint PHP
 *   table     — nombre de la tabla a inspeccionar
 *   cols      — columnas a mostrar, separadas por comas (vacío = todas)
 *   order     — columna de ordenación
 *   dir       — dirección de ordenación: 'ASC' | 'DESC'
 *   limit     — número máximo de filas a mostrar
 *   interval  — milisegundos entre ciclos de polling
 *   idCol     — nombre de la columna que actúa como clave primaria para el diff
 *   
 *   Parámetros de conexión (nuevos):
 *   dbHost    — host de la base de datos
 *   dbUser    — usuario de la base de datos
 *   dbPass    — contraseña de la base de datos
 *   dbName    — nombre de la base de datos
 *
 * Uso básico:
 *   Incluir este script en cualquier página del entorno de desarrollo.
 *   Ajustar CONFIG según la tabla que se quiera inspeccionar.
 *
 * Uso avanzado (múltiples paneles):
 *   Llamar a DbDebugPanel.addTable('nombre_tabla') desde consola para añadir tablas.
 *   DbDebugPanel.setConnection({host: '192.168.1.5', user: 'admin', pass: 'pass', db: 'mydb'})
 */

(function () {

    // ---------------------------------------------------------------------------
    // Configuración — ajustar según la tabla y entorno
    // ---------------------------------------------------------------------------

    const CONFIG = {
        endpoint : '/_debug/db-debug.php',
        table    : 'mi_tabla',      // Tabla a inspeccionar
        cols     : '',              // Ej: 'id,nombre,valor,updated_at' — vacío = todas
        order    : '',              // Columna de ordenación — vacío = sin ORDER BY explícito
        dir      : 'DESC',          // Dirección: 'ASC' | 'DESC'
        limit    : 50,              // Máximo de filas por ciclo
        interval : 2000,            // Milisegundos entre peticiones
        idCol    : 'id',            // Columna que identifica unívocamente cada fila para el diff
        
        // Parámetros de conexión (nuevos)
        dbHost   : 'localhost',
        dbUser   : 'root',
        dbPass   : '',
        dbName   : 'test_db',
    };

    // ---------------------------------------------------------------------------
    // Estado interno
    // ---------------------------------------------------------------------------

    let pollingActive = true;
    let columns       = [];         // Se populan dinámicamente en el primer ciclo exitoso

    /**
     * Cache de estados previos indexada por el valor de CONFIG.idCol.
     * Permite detectar filas nuevas y cambios entre ciclos de polling.
     * @type {Map<string, string>}
     */
    const rowCache = new Map();

    // Cargar configuración guardada de localStorage
    function loadSavedConfig() {
        const saved = localStorage.getItem('dbDebugConfig');
        if (saved) {
            try {
                const parsed = JSON.parse(saved);
                Object.assign(CONFIG, parsed);
            } catch (e) {
                console.warn('Could not parse saved config:', e);
            }
        }
    }

    // Guardar configuración a localStorage
    function saveConfig() {
        const toSave = {
            table: CONFIG.table,
            cols: CONFIG.cols,
            order: CONFIG.order,
            dir: CONFIG.dir,
            limit: CONFIG.limit,
            dbHost: CONFIG.dbHost,
            dbUser: CONFIG.dbUser,
            dbPass: CONFIG.dbPass,
            dbName: CONFIG.dbName,
        };
        localStorage.setItem('dbDebugConfig', JSON.stringify(toSave));
    }

    loadSavedConfig();

    // ---------------------------------------------------------------------------
    // Construcción del panel
    // ---------------------------------------------------------------------------

    const panel = document.createElement('div');
    panel.id = 'dbg-panel';

    panel.innerHTML = `
        <div id="dbg-header">
            <span id="dbg-title">DB DEBUG</span>
            <div id="dbg-controls">
                <select id="dbg-table-select" title="Cambiar tabla"></select>
                <label for="dbg-where-input">WHERE:</label>
                <input id="dbg-where-input" type="text" placeholder="ej: active=1">
                <button id="dbg-apply">Aplicar</button>
                <button id="dbg-connection" title="Cambiar conexión a BD">⚙️ BD</button>
                <button id="dbg-toggle">Pausar</button>
            </div>
        </div>
        <div id="dbg-table-bar">
            <input id="dbg-table-input" type="text" placeholder="Nombre de tabla...">
            <button id="dbg-table-load">Cargar tabla</button>
        </div>
        <div id="dbg-meta-bar"></div>
        <div id="dbg-table-wrapper">
            <table>
                <thead id="dbg-thead">
                    <tr></tr>
                </thead>
                <tbody id="dbg-tbody"></tbody>
            </table>
        </div>
        <div id="dbg-log"></div>
    `;

    // Modal de conexión
    const connectionModal = document.createElement('div');
    connectionModal.id = 'dbg-connection-modal';
    connectionModal.innerHTML = `
        <div id="dbg-modal-overlay"></div>
        <div id="dbg-modal-content">
            <div id="dbg-modal-header">
                <h3>Configuración de Base de Datos</h3>
                <button id="dbg-modal-close" title="Cerrar">✕</button>
            </div>
            <form id="dbg-connection-form">
                <div class="dbg-form-group">
                    <label for="dbg-host">Host:</label>
                    <input type="text" id="dbg-host" placeholder="localhost" required>
                </div>
                <div class="dbg-form-group">
                    <label for="dbg-user">Usuario:</label>
                    <input type="text" id="dbg-user" placeholder="root" required>
                </div>
                <div class="dbg-form-group">
                    <label for="dbg-pass">Contraseña:</label>
                    <input type="password" id="dbg-pass" placeholder="(vacío si no hay)">
                </div>
                <div class="dbg-form-group">
                    <label for="dbg-name">Base de datos:</label>
                    <input type="text" id="dbg-name" placeholder="test_db" required>
                </div>
                <div id="dbg-modal-buttons">
                    <button type="submit" id="dbg-modal-save">Guardar y reconectar</button>
                    <button type="button" id="dbg-modal-cancel">Cancelar</button>
                </div>
                <div id="dbg-modal-message"></div>
            </form>
        </div>
    `;

    document.body.appendChild(panel);
    document.body.appendChild(connectionModal);

    // ---------------------------------------------------------------------------
    // Estilos - Paleta formal y seria
    // ---------------------------------------------------------------------------

    const style = document.createElement('style');
    style.innerHTML = `
    #dbg-panel {
        position: fixed;
        bottom: 20px;
        right: 20px;
        width: min(650px, calc(100vw - 40px));
        max-height: min(600px, calc(100vh - 40px));
        min-width: 320px;
        min-height: 250px;
        display: flex;
        flex-direction: column;
        background: #ffffff;
        color: #334155;
        font-size: 12px;
        font-family: 'Inter', -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
        border: 1px solid #e2e8f0;
        box-shadow: 0 10px 25px -5px rgba(0, 0, 0, 0.1), 0 8px 10px -6px rgba(0, 0, 0, 0.1);
        z-index: 99999;
        resize: both;
        border-radius: 8px;
        overflow: hidden;
    }
    
    #dbg-header {
        background: #f8fafc;
        color: #0f172a;
        padding: 10px 14px;
        cursor: move;
        display: flex;
        justify-content: space-between;
        align-items: center;
        font-weight: 600;
        letter-spacing: -0.01em;
        border-bottom: 1px solid #e2e8f0;
    }
    
    #dbg-title {
        display: flex;
        align-items: center;
        gap: 8px;
        text-transform: uppercase;
        font-size: 11px;
        color: #64748b;
    }

    #dbg-controls {
        display: flex;
        align-items: center;
        gap: 8px;
    }
    
    #dbg-controls input,
    #dbg-controls select {
        background: #ffffff;
        color: #1e293b;
        border: 1px solid #cbd5e1;
        padding: 4px 8px;
        font-size: 11px;
        border-radius: 4px;
        transition: border-color 0.15s ease;
    }
    
    #dbg-controls input:focus {
        outline: none;
        border-color: #6366f1;
        ring: 2px rgba(99, 102, 241, 0.2);
    }
    
    #dbg-controls button {
        background: #475569;
        color: white;
        border: none;
        padding: 4px 12px;
        font-size: 11px;
        font-weight: 500;
        cursor: pointer;
        border-radius: 4px;
        transition: background 0.2s ease;
    }
    
    #dbg-controls button:hover {
        background: #1e293b;
    }

    #dbg-toggle, #dbg-connection {
        background: #6366f1 !important;
    }

    #dbg-toggle:hover, #dbg-connection:hover {
        background: #4f46e5 !important;
    }
    
    #dbg-table-bar {
        display: flex;
        gap: 8px;
        padding: 8px 12px;
        background: #ffffff;
        border-bottom: 1px solid #f1f5f9;
    }
    
    #dbg-table-input {
        flex: 1;
        border: 1px solid #e2e8f0;
        padding: 5px 10px;
        border-radius: 4px;
        font-size: 12px;
        background: #fcfcfd;
    }
    
    #dbg-table-load {
        background: #10b981;
        color: white;
        border: none;
        padding: 0 12px;
        font-size: 11px;
        font-weight: 600;
        border-radius: 4px;
        cursor: pointer;
    }
    
    #dbg-meta-bar {
        background: #f1f5f9;
        border-bottom: 1px solid #e2e8f0;
        padding: 4px 14px;
        font-size: 10px;
        color: #475569;
        font-family: "JetBrains Mono", "Fira Code", monospace;
    }
    
    #dbg-table-wrapper {
        overflow: auto;
        flex: 1;
        background: #ffffff;
    }
    
    #dbg-panel table {
        width: 100%;
        border-collapse: separate;
        border-spacing: 0;
    }
    
    #dbg-panel th {
        background: #f8fafc;
        color: #475569;
        font-weight: 600;
        text-align: left;
        font-size: 11px;
        padding: 10px 12px;
        border-bottom: 1px solid #e2e8f0;
        position: sticky;
        top: 0;
        z-index: 10;
        white-space: nowrap;
    }
    
    #dbg-panel td {
        padding: 8px 12px;
        border-bottom: 1px solid #f1f5f9;
        font-size: 11px;
        color: #334155;
        white-space: nowrap;
        max-width: 200px;
        overflow: hidden;
        text-overflow: ellipsis;
    }
    
    #dbg-panel tr:hover td {
        background: #f8fafc;
    }
    
    /* Indicadores de cambios con estilo sutil */
    .dbg-row-new {
        background: #f0fdf4 !important;
        box-shadow: inset 4px 0 0 #22c55e;
    }
    
    .dbg-row-changed {
        background: #fffbeb !important;
        box-shadow: inset 4px 0 0 #f59e0b;
    }
    
    #dbg-log {
        height: 80px;
        overflow-y: auto;
        border-top: 1px solid #e2e8f0;
        padding: 8px 14px;
        font-size: 10px;
        color: #64748b;
        background: #f8fafc;
        font-family: monospace;
    }
    
    #dbg-log div {
        padding: 2px 0;
        border-bottom: 1px solid #f1f5f9;
    }

    /* Scrollbar minimalista */
    #dbg-table-wrapper::-webkit-scrollbar { width: 8px; height: 8px; }
    #dbg-table-wrapper::-webkit-scrollbar-track { background: #f1f5f9; }
    #dbg-table-wrapper::-webkit-scrollbar-thumb { background: #cbd5e1; border-radius: 4px; }
    #dbg-table-wrapper::-webkit-scrollbar-thumb:hover { background: #94a3b8; }

    /* Estilos del modal de conexión */
    #dbg-connection-modal {
        display: none;
        position: fixed;
        top: 0;
        left: 0;
        width: 100%;
        height: 100%;
        z-index: 99998;
    }

    #dbg-modal-overlay {
        position: absolute;
        top: 0;
        left: 0;
        width: 100%;
        height: 100%;
        background: rgba(0, 0, 0, 0.4);
        backdrop-filter: blur(2px);
    }

    #dbg-modal-content {
        position: absolute;
        top: 50%;
        left: 50%;
        transform: translate(-50%, -50%);
        background: #ffffff;
        border-radius: 8px;
        border: 1px solid #e2e8f0;
        box-shadow: 0 20px 25px -5px rgba(0, 0, 0, 0.1);
        width: min(420px, calc(100vw - 40px));
        padding: 0;
        font-family: 'Inter', -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    }

    #dbg-modal-header {
        display: flex;
        justify-content: space-between;
        align-items: center;
        padding: 16px 20px;
        border-bottom: 1px solid #e2e8f0;
        background: #f8fafc;
    }

    #dbg-modal-header h3 {
        margin: 0;
        font-size: 14px;
        font-weight: 600;
        color: #0f172a;
    }

    #dbg-modal-close {
        background: none;
        border: none;
        font-size: 18px;
        cursor: pointer;
        color: #64748b;
        padding: 0;
        width: 24px;
        height: 24px;
        display: flex;
        align-items: center;
        justify-content: center;
        transition: color 0.2s;
    }

    #dbg-modal-close:hover {
        color: #0f172a;
    }

    #dbg-connection-form {
        padding: 20px;
    }

    .dbg-form-group {
        margin-bottom: 14px;
        display: flex;
        flex-direction: column;
    }

    .dbg-form-group label {
        font-size: 12px;
        font-weight: 500;
        color: #334155;
        margin-bottom: 4px;
    }

    .dbg-form-group input {
        padding: 8px 10px;
        border: 1px solid #cbd5e1;
        border-radius: 4px;
        font-size: 12px;
        color: #1e293b;
        background: #fcfcfd;
        font-family: 'Inter', -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
        transition: border-color 0.2s;
    }

    .dbg-form-group input:focus {
        outline: none;
        border-color: #6366f1;
        background: #ffffff;
        box-shadow: 0 0 0 2px rgba(99, 102, 241, 0.1);
    }

    #dbg-modal-buttons {
        display: flex;
        gap: 10px;
        margin-top: 20px;
    }

    #dbg-modal-save, #dbg-modal-cancel {
        flex: 1;
        padding: 8px 14px;
        border: none;
        border-radius: 4px;
        font-size: 12px;
        font-weight: 500;
        cursor: pointer;
        transition: background 0.2s;
    }

    #dbg-modal-save {
        background: #6366f1;
        color: white;
    }

    #dbg-modal-save:hover {
        background: #4f46e5;
    }

    #dbg-modal-cancel {
        background: #e2e8f0;
        color: #334155;
    }

    #dbg-modal-cancel:hover {
        background: #cbd5e1;
    }

    #dbg-modal-message {
        margin-top: 10px;
        padding: 8px 10px;
        border-radius: 4px;
        font-size: 11px;
        display: none;
    }

    #dbg-modal-message.success {
        background: #d1fae5;
        color: #065f46;
        border: 1px solid #a7f3d0;
        display: block;
    }

    #dbg-modal-message.error {
        background: #fee2e2;
        color: #991b1b;
        border: 1px solid #fecaca;
        display: block;
    }
    `;
    document.head.appendChild(style);

    // ---------------------------------------------------------------------------
    // Comportamiento arrastrable
    // ---------------------------------------------------------------------------

    let isDragging = false;
    let dragOffsetX = 0;
    let dragOffsetY = 0;

    const header = panel.querySelector('#dbg-header');

    header.addEventListener('mousedown', (e) => {
        const interactiveTargets = ['INPUT', 'SELECT', 'BUTTON', 'LABEL'];
        if (interactiveTargets.includes(e.target.tagName)) return;

        // getBoundingClientRect devuelve la posición real en pantalla,
        // necesario porque el panel arranca con bottom/right en vez de top/left.
        const rect  = panel.getBoundingClientRect();
        isDragging  = true;
        dragOffsetX = e.clientX - rect.left;
        dragOffsetY = e.clientY - rect.top;

        // Convertimos bottom/right a top/left para que el drag funcione correctamente
        panel.style.left   = rect.left + 'px';
        panel.style.top    = rect.top  + 'px';
        panel.style.right  = 'auto';
        panel.style.bottom = 'auto';
    });

    document.addEventListener('mousemove', (e) => {
        if (!isDragging) return;

        // Mantenemos el panel dentro de los límites de la ventana
        const maxX = window.innerWidth  - panel.offsetWidth;
        const maxY = window.innerHeight - panel.offsetHeight;
        const newX = Math.min(Math.max(0, e.clientX - dragOffsetX), maxX);
        const newY = Math.min(Math.max(0, e.clientY - dragOffsetY), maxY);

        panel.style.left = newX + 'px';
        panel.style.top  = newY + 'px';
    });

    document.addEventListener('mouseup', () => { isDragging = false; });

    // ---------------------------------------------------------------------------
    // Utilidades
    // ---------------------------------------------------------------------------

    function appendLog(message) {
        const logDiv    = panel.querySelector('#dbg-log');
        const timestamp = new Date().toLocaleTimeString();
        const entry     = document.createElement('div');
        entry.textContent = `[${timestamp}] ${message}`;
        logDiv.prepend(entry);
    }

    function escapeHtml(value) {
        const str = String(value ?? '');
        return str
            .replace(/&/g,  '&amp;')
            .replace(/</g,  '&lt;')
            .replace(/>/g,  '&gt;')
            .replace(/"/g,  '&quot;')
            .replace(/'/g,  '&#39;');
    }

    /**
     * Actualiza la fila de cabeceras a partir del array de columnas devuelto
     * por el endpoint. Cada cabecera permite ordenar al hacer clic.
     * @param {string[]} cols
     */
    function renderHeaders(cols) {
        const tr = panel.querySelector('#dbg-thead tr');
        tr.innerHTML = '';

        cols.forEach(col => {
            const th  = document.createElement('th');
            th.textContent = col;
            th.title  = `Ordenar por ${col}`;

            th.addEventListener('click', () => {
                CONFIG.dir   = CONFIG.order === col && CONFIG.dir === 'DESC' ? 'ASC' : 'DESC';
                CONFIG.order = col;
                saveConfig();
                fetchAndRender();
            });

            tr.appendChild(th);
        });
    }

    // ---------------------------------------------------------------------------
    // Ciclo de polling
    // ---------------------------------------------------------------------------

    async function fetchAndRender() {
        if (!pollingActive) return;

        const params = new URLSearchParams({ 
            table: CONFIG.table, 
            limit: CONFIG.limit,
            host: CONFIG.dbHost,
            user: CONFIG.dbUser,
            pass: CONFIG.dbPass,
            db: CONFIG.dbName,
        });
        if (CONFIG.cols)  params.set('cols',  CONFIG.cols);
        if (CONFIG.order) params.set('order', CONFIG.order);
        if (CONFIG.dir)   params.set('dir',   CONFIG.dir);

        const whereInput = document.getElementById('dbg-where-input').value.trim();
        if (whereInput)   params.set('where', whereInput);

        try {
            const response = await fetch(`${CONFIG.endpoint}?${params.toString()}`);
            const payload  = await response.json();

            if (payload.error) {
                appendLog(`Error: ${payload.error}`);
                return;
            }

            const { meta, rows } = payload;

            // Usamos la clave primaria detectada por el servidor.
            // Si no hay PK definida en la tabla, el PHP devuelve la primera columna como fallback.
            const pkCol = meta.primary_key || CONFIG.idCol;

            panel.querySelector('#dbg-title').textContent     = `DB DEBUG — ${meta.table}`;
            panel.querySelector('#dbg-meta-bar').textContent  = `SQL: ${meta.sql}  |  Filas: ${meta.count}  |  PK: ${pkCol}  |  Conexión: ${meta.connection.user}@${meta.connection.host}/${meta.connection.db}`;

            // Renderizar cabeceras solo si las columnas cambiaron
            const colsKey = (meta.cols || []).join(',');
            if (colsKey !== columns.join(',')) {
                columns = meta.cols || [];
                renderHeaders(columns);
            }

            const tbody = panel.querySelector('#dbg-tbody');
            tbody.innerHTML = '';

            rows.forEach(row => {
                const rowId      = String(row[pkCol] ?? JSON.stringify(row));
                const serialized = JSON.stringify(row);
                const tr         = document.createElement('tr');

                if (!rowCache.has(rowId)) {
                    tr.classList.add('dbg-row-new');
                    appendLog(`Nuevo registro — ${pkCol}: ${rowId}`);
                } else if (rowCache.get(rowId) !== serialized) {
                    tr.classList.add('dbg-row-changed');
                    appendLog(`Cambio detectado — ${pkCol}: ${rowId}`);
                }

                columns.forEach(col => {
                    const td = document.createElement('td');
                    td.innerHTML = escapeHtml(row[col] ?? '');
                    tr.appendChild(td);
                });

                tbody.appendChild(tr);
                rowCache.set(rowId, serialized);
            });

        } catch (err) {
            appendLog(`Error de conexión: ${err.message}`);
        }
    }

    // ---------------------------------------------------------------------------
    // Modal de configuración de conexión
    // ---------------------------------------------------------------------------

    function openConnectionModal() {
        document.getElementById('dbg-host').value = CONFIG.dbHost;
        document.getElementById('dbg-user').value = CONFIG.dbUser;
        document.getElementById('dbg-pass').value = CONFIG.dbPass;
        document.getElementById('dbg-name').value = CONFIG.dbName;
        document.getElementById('dbg-modal-message').textContent = '';
        document.getElementById('dbg-modal-message').className = '';
        connectionModal.style.display = 'block';
    }

    function closeConnectionModal() {
        connectionModal.style.display = 'none';
    }

    function showMessage(text, type) {
        const msgDiv = document.getElementById('dbg-modal-message');
        msgDiv.textContent = text;
        msgDiv.className = type;
    }

    // ---------------------------------------------------------------------------
    // Controles de UI
    // ---------------------------------------------------------------------------

    panel.querySelector('#dbg-toggle').addEventListener('click', function () {
        pollingActive    = !pollingActive;
        this.textContent = pollingActive ? 'Pausar' : 'Reanudar';
        appendLog(pollingActive ? 'Polling reanudado' : 'Polling pausado');
    });

    panel.querySelector('#dbg-connection').addEventListener('click', () => {
        openConnectionModal();
    });

    panel.querySelector('#dbg-apply').addEventListener('click', () => {
        rowCache.clear();
        fetchAndRender();
        appendLog(`Filtro aplicado — tabla: ${CONFIG.table}`);
    });

    panel.querySelector('#dbg-table-load').addEventListener('click', () => {
        const input = document.getElementById('dbg-table-input');
        const tableName = input.value.trim();
        if (!tableName) return;

        // Añadir al selector si no existe ya
        const selectEl = panel.querySelector('#dbg-table-select');
        const existing = Array.from(selectEl ? selectEl.options : []).map(o => o.value);
        if (!existing.includes(tableName)) {
            const o       = document.createElement('option');
            o.value       = tableName;
            o.textContent = tableName;
            selectEl.appendChild(o);
        }

        CONFIG.table = tableName;
        CONFIG.order = '';
        columns      = [];
        rowCache.clear();
        panel.querySelector('#dbg-table-select').value = tableName;
        saveConfig();
        fetchAndRender();
        appendLog(`Tabla cargada: ${tableName}`);
        input.value = '';
    });

    // Cargar tabla también al pulsar Enter en el campo
    panel.querySelector('#dbg-table-input').addEventListener('keydown', (e) => {
        if (e.key === 'Enter') panel.querySelector('#dbg-table-load').click();
    });

    panel.querySelector('#dbg-table-select').addEventListener('change', function () {
        CONFIG.table = this.value;
        CONFIG.order = '';
        columns      = [];
        rowCache.clear();
        saveConfig();
        fetchAndRender();
        appendLog(`Tabla cambiada a: ${CONFIG.table}`);
    });

    // Modal eventos
    document.getElementById('dbg-modal-close').addEventListener('click', closeConnectionModal);
    document.getElementById('dbg-modal-cancel').addEventListener('click', closeConnectionModal);
    
    document.getElementById('dbg-modal-overlay').addEventListener('click', closeConnectionModal);

    document.getElementById('dbg-connection-form').addEventListener('submit', (e) => {
        e.preventDefault();

        const newHost = document.getElementById('dbg-host').value.trim();
        const newUser = document.getElementById('dbg-user').value.trim();
        const newPass = document.getElementById('dbg-pass').value;
        const newName = document.getElementById('dbg-name').value.trim();

        if (!newHost || !newUser || !newName) {
            showMessage('Por favor, completa todos los campos requeridos.', 'error');
            return;
        }

        // Actualizar configuración
        CONFIG.dbHost = newHost;
        CONFIG.dbUser = newUser;
        CONFIG.dbPass = newPass;
        CONFIG.dbName = newName;

        saveConfig();
        rowCache.clear();

        showMessage('Configuración guardada. Reconectando...', 'success');

        // Reintentar conexión después de un pequeño delay
        setTimeout(() => {
            fetchAndRender();
            appendLog(`Reconexión a ${newUser}@${newHost}/${newName}`);
        }, 500);
    });

    // ---------------------------------------------------------------------------
    // API pública
    // ---------------------------------------------------------------------------

    const selectEl = panel.querySelector('#dbg-table-select');
    const opt      = document.createElement('option');
    opt.value      = CONFIG.table;
    opt.textContent = CONFIG.table;
    selectEl.appendChild(opt);

    /**
     * API pública accesible desde consola del navegador.
     *
     * Ejemplos:
     *   DbDebugPanel.addTable('ps_orders');
     *   DbDebugPanel.addTable('ps_customer');
     *   DbDebugPanel.setTable('ps_orders');
     *   DbDebugPanel.setConnection({host: '192.168.1.5', user: 'admin', pass: 'pass', db: 'mydb'});
     *   DbDebugPanel.config.interval = 5000;
     */
    window.DbDebugPanel = {
        addTable(tableName) {
            const o       = document.createElement('option');
            o.value       = tableName;
            o.textContent = tableName;
            selectEl.appendChild(o);
        },
        setTable(tableName) {
            CONFIG.table = tableName;
            columns      = [];
            rowCache.clear();
            saveConfig();
            fetchAndRender();
        },
        setConnection(connectionObj) {
            if (connectionObj.host) CONFIG.dbHost = connectionObj.host;
            if (connectionObj.user) CONFIG.dbUser = connectionObj.user;
            if (connectionObj.pass !== undefined) CONFIG.dbPass = connectionObj.pass;
            if (connectionObj.db) CONFIG.dbName = connectionObj.db;
            rowCache.clear();
            saveConfig();
            fetchAndRender();
        },
        config: CONFIG,
    };

    // ---------------------------------------------------------------------------
    // Arranque
    // ---------------------------------------------------------------------------

    appendLog(`Panel iniciado — tabla: ${CONFIG.table} — polling cada ${CONFIG.interval}ms`);
    appendLog(`Conexión: ${CONFIG.dbUser}@${CONFIG.dbHost}/${CONFIG.dbName}`);
    setInterval(fetchAndRender, CONFIG.interval);
    fetchAndRender();

})();
