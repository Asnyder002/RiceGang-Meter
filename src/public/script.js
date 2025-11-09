// ============================================================================
// script.js — refactor SOLID-friendly, single-file version
// ============================================================================

(() => {
    "use strict";

    // ==========================================================================
    // 1) Configuration (constantes, clés, options)
    //    SRP: ne contient que la config. OCP: extensible sans toucher au code.
    // ==========================================================================

    /** @typedef {"dps"|"heal"|"tank"} TabKey */

    const CONFIG = Object.freeze({
        SERVER_URL: "localhost:8990",
        WS_RECONNECT_MS: 5000,
        OPEN_SPELLS_IN_WINDOW: true,
        COLOR_HUES: [210, 30, 270, 150, 330, 60, 180, 0, 240],
        NUMERIC_KEYS_WHITELIST: null, // ex: ["totalDamage","totalHits","critHits"]
        SKILL_MERGE_MAP: {
            /*"1701": ["1702", "1703", "1704", "1739"],
            "1740": ["1741"],
            "1901": ["1903", "1904", "1902"],
            "1922": ["1932"],
            "2201172": ["1909"],*/
        },
        CLASS_COLORS: {
            wind_knight: "#4aff5a",
            stormblade: "#a155ff",
            frost_mage: "#00b4ff",
            heavy_guardian: "#c08a5c",
            shield_knight: "#f2d05d",
            marksman: "#ff6a00",
            soul_musician: "#ff4a4a",
            verdant_oracle: "#6cff94",
            default: "#999999",
        },
        SPEC_ICONS: {
            wind_knight: { skyward: ["spec_skyward.webp"], vanguard: ["spec_vanguard.webp"], default: ["wind_knight.webp"] },
            stormblade: { iaido: ["spec_slash.webp"], moonstrike: ["spec_moon.webp"], default: ["stormblade.webp"] },
            frost_mage: { icicle: ["spec_icicle.webp"], frostbeam: ["spec_frostbeam.webp"], default: ["frost_mage.webp"] },
            heavy_guardian: { block: ["spec_block.webp"], earthfort: ["spec_earth.webp"], default: ["heavy_guardian.webp"] },
            shield_knight: { shield: ["spec_shield.webp"], recovery: ["spec_recovery.webp"], default: ["shield_knight.webp"] },
            marksman: { wildpack: ["spec_wildpack.webp"], falconry: ["spec_falcon.webp"], default: ["marksman.webp"] },
            soul_musician: { concerto: ["spec_concerto.webp"], dissonance: ["spec_diss.webp"], default: ["soul_musician.webp"] },
            verdant_oracle: { lifebind: ["spec_lifebind.webp"], smite: ["spec_smite.webp"], default: ["verdant_oracle.webp"] },
            default: { default: ["spec_shield.webp"] },
        },
        TABS: { DPS: "dps", HEAL: "heal", TANK: "tank" },
    });

    // ==========================================================================
    // 2) État de l’application
    //    SRP: porte uniquement l’état. DIP: pas de dépendance directe à l’UI ici.
    // ==========================================================================

    const State = {
        activeTab: /** @type {TabKey} */ (CONFIG.TABS.DPS),
        paused: false,
        socket: /** @type {any} */ (null),
        wsConnected: false,
        lastWsMessageTs: Date.now(),
        colorIndex: 0,
        users: /** @type {Record<string, any>} */ ({}),
        skillsByUser: /** @type {Record<string, any>} */ ({}),
        renderPending: false,
        // fenêtre des sorts
        spellWindowRef: /** @type {Window|null} */ (null),
        currentSpellUserId: /** @type {string|null} */ (null),
        spellWindowWatchdog: /** @type {number|null} */ (null),
        // live skills view state
        viewMode: "main", // "main" or "live-skills"
        liveSkillsUserId: /** @type {string|null} */ (null),
        liveSkillsUserName: /** @type {string|null} */ (null),
    };

    window.__sessionStartTs ??= null;
    window.__lastUpdateTs ??= null;

    function bringToFront(winRef, nameHint) {
        try { window.focus(); } catch { }
        try { winRef?.focus?.(); } catch { }

        setTimeout(() => { try { winRef?.focus?.(); } catch { } }, 0);
        setTimeout(() => { try { winRef?.focus?.(); } catch { } }, 120);

        try { window.electronAPI?.focusChildWindow?.(nameHint || ""); } catch { }
    }

    // ==========================================================================
    // 3) Utilitaires purs
    //    SRP: fonctions pures & petites. Testables. Aucune dépendance DOM.
    // ==========================================================================

    const clamp = (n, min, max) => Math.min(Math.max(n, min), max);

    function formatNumber(n) {
        if (typeof n !== "number" || Number.isNaN(n)) return "NaN";
        if (n >= 1e6) return (n / 1e6).toFixed(1) + "M";
        if (n >= 1e3) return (n / 1e3).toFixed(1) + "K";
        return Math.round(n).toString();
    }

    function getClassKey(profession = "") {
        const p = profession.toLowerCase();
        if (p.includes("wind")) return "wind_knight";
        if (p.includes("storm")) return "stormblade";
        if (p.includes("frost")) return "frost_mage";
        if (p.includes("guardian")) return "heavy_guardian";
        if (p.includes("shield")) return "shield_knight";
        if (p.includes("mark")) return "marksman";
        if (p.includes("soul")) return "soul_musician";
        if (p.includes("verdant")) return "verdant_oracle";
        return "default";
    }

    const TabValue = /** OCP: mapping extensible */ {
        [CONFIG.TABS.DPS]: (u) => u.total_damage?.total ?? 0,
        [CONFIG.TABS.HEAL]: (u) => u.total_healing?.total ?? 0,
        [CONFIG.TABS.TANK]: (u) => u.taken_damage ?? 0,
    };

    function valueForTab(u, activeTab) {
        return (TabValue[activeTab] ?? (() => 0))(u);
    }

    function statLine(u, activeTab, percent) {
        const p = percent.toFixed(1);
        switch (activeTab) {
            case CONFIG.TABS.DPS:
                return `${formatNumber(u.total_damage.total)} (${formatNumber(u.total_dps)} DPS, ${p}%)`;
            case CONFIG.TABS.HEAL:
                return `${formatNumber(u.total_healing.total)} (${formatNumber(u.total_hps)} HPS, ${p}%)`;
            case CONFIG.TABS.TANK:
                return `${formatNumber(u.taken_damage)} (${p}%)`;
            default:
                return "";
        }
    }

    // ==========================================================================
    // 4) Fusion des compétences (algorithme pur)
    // ==========================================================================

    /**
     * Merge skills with a mapping of ids to fold.
     * ISP: l’API ne fait que de la fusion.
     */
    function mergeSkills(
        skills,
        mergeMap = CONFIG.SKILL_MERGE_MAP,
        numericKeys = CONFIG.NUMERIC_KEYS_WHITELIST
    ) {
        if (!skills) return {};
        const result = Object.fromEntries(Object.entries(skills).map(([id, d]) => [id, { ...d }]));
        const mergedIds = new Set();

        for (const [mainId, others] of Object.entries(mergeMap)) {
            const group = [mainId, ...others].filter((id) => result[id]);
            if (!group.length) continue;
            if (group.some((id) => mergedIds.has(id))) continue;

            const keepId = result[mainId] ? mainId : group[0];
            const merged = { ...result[keepId] };
            merged.displayName = result[keepId]?.displayName ?? merged.displayName;

            for (const id of group) {
                if (id === keepId) continue;
                const src = result[id];
                if (!src) continue;

                for (const [k, v] of Object.entries(src)) {
                    if (typeof v === "number" && Number.isFinite(v)) {
                        if (numericKeys && !numericKeys.includes(k)) continue;
                        merged[k] = (merged[k] ?? 0) + v;
                    }
                }
            }

            result[keepId] = merged;
            for (const id of group) {
                if (id !== keepId) delete result[id];
                mergedIds.add(id);
            }
        }
        return result;
    }

    // ==========================================================================
    // 5) DOM layer (sélection + helpers)
    //    SRP: tient les références DOM et opérations de base sur le DOM.
    // ==========================================================================

    const $ = (sel) => /** @type {HTMLElement} */(document.querySelector(sel));
    const $$ = (sel) => /** @type {NodeListOf<HTMLElement>} */(document.querySelectorAll(sel));

    const Dom = {
        columns: $("#columnsContainer"),
        settings: $("#settingsContainer"),
        help: $("#helpContainer"),
        passthroughTitle: $("#passthroughTitle"),
        pauseBtn: $("#pauseButton"),
        clearBtn: $("#clearButton"),
        helpBtn: $("#helpButton"),
        settingsBtn: $("#settingsButton"),
        closeBtn: $("#closeButton"),
        opacity: /** @type {HTMLInputElement} */ ($("#opacitySlider")),
        serverStatus: $("#serverStatus"),
        tabButtons: $$(".tab-button"),
        allButtons: [$("#clearButton"), $("#pauseButton"), $("#helpButton"), $("#settingsButton"), $("#closeButton"), $("#btnOpenSessions")],
        popup: {
            container: $("#spellPopup"),
            title: $("#popupTitle"),
            list: $("#spellList"),
        },
        sessionsBtn: $("#btnOpenSessions"),
    };

    function setBackgroundOpacity(v) {
        const val = clamp(Number(v), 0, 1);
        document.documentElement.style.setProperty("--main-bg-opacity", String(val));
    }

    function setServerStatus(status /** "connected"|"disconnected"|"paused"|"reconnecting"|"cleared" */) {
        Dom.serverStatus.className = `status-indicator ${status}`;
    }

    function getServerStatus() {
        return Dom.serverStatus.className.replace("status-indicator ", "");
    }

    // ==========================================================================
    // 6) Rendu liste principale (Renderer)
    //    SRP: produire/mettre à jour la vue. LSP: fonctionne pour toute source users.
    // ==========================================================================

    const Renderer = {
        /** Met à jour l’UI à partir d’un tableau d’utilisateurs. */
        renderDataList(users, activeTab) {
            if (State.viewMode === "live-skills") {
                this.renderLiveSkillsView();
                return;
            }
            
            if (State.renderPending) return;
            State.renderPending = true;

            requestAnimationFrame(() => {
                State.renderPending = false;

                const total = users.reduce((s, u) => s + valueForTab(u, activeTab), 0);
                users.sort((a, b) => valueForTab(b, activeTab) - valueForTab(a, activeTab));

                const top1 = users[0] ? valueForTab(users[0], activeTab) : 0;
                const seen = new Set();

                const prevPos = new Map();
                Array.from(Dom.columns.children).forEach((li) => {
                    prevPos.set(li.dataset.userid, li.getBoundingClientRect().top);
                });

                // CREATE/UPDATE
                for (let i = 0; i < users.length; i++) {
                    const user = users[i];
                    const uid = String(user.id);
                    seen.add(uid);

                    const classKey = getClassKey(user.profession);
                    const baseColor = CONFIG.CLASS_COLORS[classKey] ?? CONFIG.CLASS_COLORS.default;
                    const iconPack = CONFIG.SPEC_ICONS[classKey] || CONFIG.SPEC_ICONS.default;
                    const sub = user.subProfession || "default";
                    const specFiles = iconPack[sub] || iconPack.default || iconPack[Object.keys(iconPack)[0]];

                    const barPercent = top1 ? (valueForTab(user, activeTab) / top1) * 100 : 0;
                    const displayPercent = total ? (valueForTab(user, activeTab) / total) * 100 : 0;
                    const stats = statLine(user, activeTab, displayPercent);
                    const displayName = user.fightPoint ? `${user.name} (${user.fightPoint})` : user.name;

                    let li = Dom.columns.querySelector(`.data-item[data-userid="${uid}"]`);
                    if (!li) {
                        li = document.createElement("li");
                        li.className = `data-item ${classKey}`;
                        li.dataset.userid = uid;
                        li.innerHTML = `
              <div class="main-bar">
                <div class="dps-bar-fill"></div>
                <div class="content">
                  <span class="rank"></span>
                  <span class="spec-icons"></span>
                  <span class="name"></span>
                  <span class="stats"></span>
                  <button class="spell-btn" title="Player Details">
                    <svg viewBox="0 0 24 24" width="14" height="14">
                      <path fill="currentColor" d="M15.5 14h-.79l-.28-.27A6.471 6.471 0 0016 9.5 
                      6.5 6.5 0 109.5 16c1.61 0 3.09-.59 
                      4.23-1.57l.27.28v.79l5 4.99L20.49 
                      19l-4.99-5zm-6 0C8.01 14 6 11.99 
                      6 9.5S8.01 5 10.5 5 15 7.01 
                      15 9.5 12.99 14 10.5 14z"/>
                    </svg>
                  </button>
                </div>
              </div>
            `;
                        li.querySelector(".spell-btn").addEventListener("click", (e) => {
                            e.stopPropagation();
                            UI.showPopupForUser(uid);
                        });
                        // Add right-click context menu for live skills view (works on all tabs)
                        li.addEventListener("contextmenu", (e) => {
                            e.preventDefault();
                            e.stopPropagation();
                            UI.showLiveSkillsForUser(uid, user.name);
                        });
                        Dom.columns.appendChild(li);
                    } else {
                        li.className = `data-item ${classKey}`;
                    }

                    const fill = li.querySelector(".dps-bar-fill");
                    const rankEl = li.querySelector(".rank");
                    const specIcons = li.querySelector(".spec-icons");
                    const nameEl = li.querySelector(".name");
                    const statsEl = li.querySelector(".stats");

                    rankEl.textContent = `${i + 1}.`;
                    nameEl.textContent = displayName;
                    statsEl.textContent = stats;
                    fill.style.transition = "width 0.3s ease";
                    fill.style.width = `${barPercent}%`;
                    fill.style.background = `linear-gradient(90deg, ${baseColor}, rgba(0,0,0,0.3))`;

                    const currentSrcs = Array.from(specIcons.querySelectorAll("img")).map((img) => img.getAttribute("src"));

                    const ASSETS_BASES = ["assets/classes/", "assets/specs/"];

                    const desiredFiles = (specFiles || []).slice();

                    const currentFiles = Array.from(specIcons.querySelectorAll("img"))
                        .map(img => img.dataset.file || "");

                    if (currentFiles.join("|") !== desiredFiles.join("|")) {
                        specIcons.replaceChildren();

                        for (const f of desiredFiles) {
                            const img = document.createElement("img");
                            img.className = "spec-icon";
                            img.dataset.file = f;
                            img.decoding = "async";
                            img.loading = "lazy";

                            img.onerror = () => {
                                // fallback unique vers /specs/ si /classes/ échoue
                                if (!img.dataset.fallbackTried) {
                                    img.dataset.fallbackTried = "1";
                                    img.src = `${ASSETS_BASES[1]}${f}`;
                                } else {
                                    // si fallback échoue aussi, on retire proprement l’élément
                                    img.remove();
                                }
                            };

                            img.src = `${ASSETS_BASES[0]}${f}`;
                            specIcons.appendChild(img);
                        }
                    }
                }

                // REMOVE ABSENTS
                Array.from(Dom.columns.children).forEach((li) => {
                    const uid = li.dataset.userid;
                    if (!seen.has(uid)) li.remove();
                });

                // REORDER + FLIP animation (sans reparenting)
                const currentLis = Array.from(Dom.columns.children);
                const desiredOrder = users.map((u) => String(u.id));

                // 1) Mesure positions AVANT (déjà fait plus haut dans ton code via prevPos)

                // 2) Appliquer l'ordre visuel uniquement
                for (let i = 0; i < desiredOrder.length; i++) {
                    const id = desiredOrder[i];
                    const li = Dom.columns.querySelector(`.data-item[data-userid="${id}"]`);
                    if (li) li.style.order = String(i);
                }

                // 3) Mesure APRES + FLIP
                currentLis.forEach((li) => {
                    const uid = li.dataset.userid;
                    const prevTop = prevPos.get(uid);
                    const newTop = li.getBoundingClientRect().top;
                    if (prevTop != null) {
                        const deltaY = prevTop - newTop;
                        if (Math.abs(deltaY) > 1) {
                            li.style.transition = "none";
                            li.style.transform = `translateY(${deltaY}px)`;
                            requestAnimationFrame(() => {
                                li.style.transition = "transform 0.25s ease";
                                li.style.transform = "";
                            });
                        }
                    }
                });
            });
        },

        renderLiveSkillsView() {
            if (State.renderPending) return;
            State.renderPending = true;

            requestAnimationFrame(() => {
                State.renderPending = false;
                
                const userId = State.liveSkillsUserId;
                const userName = State.liveSkillsUserName;
                
                if (!userId || !userName) {
                    // Fallback to main view if no user selected
                    State.viewMode = "main";
                    return;
                }

                const user = State.users[userId];
                const skillsData = State.skillsByUser[userId];
                
                // If user or skills data is no longer available, return to main view
                if (!user || !skillsData) {
                    State.viewMode = "main";
                    State.liveSkillsUserId = null;
                    State.liveSkillsUserName = null;
                    this.renderMain();
                    return;
                }
                
                // Check if the live skills container already exists
                let container = Dom.columns.querySelector('.live-skills-container');
                
                if (!container) {
                    // Clear existing content and create new container
                    Dom.columns.innerHTML = '';
                    
                    container = document.createElement('div');
                    container.className = 'live-skills-container';
                    container.innerHTML = `
                        <div class="live-skills-header">
                            <button class="back-button" title="Back to Main View">
                                <svg viewBox="0 0 24 24" width="10" height="10">
                                    <path fill="currentColor" d="M20 11v2H8l5.5 5.5-1.42 1.42L4.16 12l7.92-7.92L13.5 5.5 8 11h12z"/>
                                </svg>
                                Back
                            </button>
                            <div class="header-content">
                                <span class="player-name">${userName}</span>
                                <div class="stats-line">
                                    <span class="total-damage">${user ? formatNumber(valueForTab(user, State.activeTab)) : '0'}</span>
                                    <span class="tab-label">${this.getTabLabel(State.activeTab)}</span>
                                    <span class="separator">•</span>
                                    <span class="dps-value">${this.calculateDPS(user)} ${this.getTabRateLabel(State.activeTab)}</span>
                                    <span class="separator">•</span>
                                    ${State.activeTab === CONFIG.TABS.TANK ? `
                                        <span class="death-count">${user && user.dead_count ? user.dead_count : '0'} Deaths</span>
                                    ` : `
                                        <span class="crit-rate">${this.calculateOverallCritRate(user)}% Crit</span>
                                        <span class="separator">•</span>
                                        <span class="luck-rate">${this.calculateOverallLuckRate(user)}% Luck</span>
                                    `}
                                </div>
                            </div>
                        </div>
                        <div class="skills-list" id="liveSkillsList">
                            ${this.renderSkillsList(skillsData, user)}
                        </div>
                    `;

                    // Add back button event listener
                    const backButton = container.querySelector('.back-button');
                    backButton.addEventListener('click', () => {
                        State.viewMode = "main";
                        State.liveSkillsUserId = null;
                        State.liveSkillsUserName = null;
                        // Trigger re-render of main view
                        const users = Object.values(State.users);
                        this.renderDataList(users, State.activeTab);
                    });

                    Dom.columns.appendChild(container);
                } else {
                    // Update existing container without recreating it
                    const statsContainer = container.querySelector('.header-content');
                    if (statsContainer) {
                        // Rebuild the entire header content to handle tab changes
                        statsContainer.innerHTML = `
                            <span class="player-name">${userName}</span>
                            <div class="stats-line">
                                <span class="total-damage">${user ? formatNumber(valueForTab(user, State.activeTab)) : '0'}</span>
                                <span class="tab-label">${this.getTabLabel(State.activeTab)}</span>
                                <span class="separator">•</span>
                                <span class="dps-value">${this.calculateDPS(user)} ${this.getTabRateLabel(State.activeTab)}</span>
                                <span class="separator">•</span>
                                ${State.activeTab === CONFIG.TABS.TANK ? `
                                    <span class="death-count">${user && user.dead_count ? user.dead_count : '0'} Deaths</span>
                                ` : `
                                    <span class="crit-rate">${this.calculateOverallCritRate(user)}% Crit</span>
                                    <span class="separator">•</span>
                                    <span class="luck-rate">${this.calculateOverallLuckRate(user)}% Luck</span>
                                `}
                            </div>
                        `;
                    }
                    
                    // Update skills list content
                    const skillsList = container.querySelector('#liveSkillsList');
                    if (skillsList) {
                        skillsList.innerHTML = this.renderSkillsList(skillsData, user);
                    }
                }
            });
        },

        calculateDPS(user) {
            if (!user) return '0';
            
            // Use the appropriate DPS value based on active tab
            switch (State.activeTab) {
                case CONFIG.TABS.DPS:
                    return formatNumber(user.total_dps || 0);
                case CONFIG.TABS.HEAL:
                    return formatNumber(user.total_hps || 0);
                case CONFIG.TABS.TANK:
                    return formatNumber(user.taken_dps || 0);
                default:
                    return '0';
            }
        },

        getTabRateLabel(activeTab) {
            switch (activeTab) {
                case CONFIG.TABS.DPS:
                    return 'DPS';
                case CONFIG.TABS.HEAL:
                    return 'HPS';
                case CONFIG.TABS.TANK:
                    return 'DTPS'; // Damage Taken Per Second
                default:
                    return 'DPS';
            }
        },

        getTabLabel(activeTab) {
            switch (activeTab) {
                case CONFIG.TABS.DPS:
                    return 'Total Damage';
                case CONFIG.TABS.HEAL:
                    return 'Total Healing';
                case CONFIG.TABS.TANK:
                    return 'Total Damage Taken';
                default:
                    return 'Total';
            }
        },

        calculateMitigationRate(user) {
            if (!user) return '0.0';
            
            // Try to get mitigation percentage from user data
            if (user.mitigation_percent !== undefined && user.mitigation_percent !== null) {
                return user.mitigation_percent.toFixed(1);
            }
            
            // Fallback calculation if needed
            if (user.raw_taken_damage && user.taken_damage && user.raw_taken_damage > 0) {
                const mitigationPercent = ((user.raw_taken_damage - user.taken_damage) / user.raw_taken_damage * 100);
                return mitigationPercent.toFixed(1);
            }
            
            return '0.0';
        },

        calculateOverallCritRate(user) {
            if (!user) return '0.0';
            
            // Try to get from total_count if available, otherwise fall back to stats
            let totalHits, critHits;
            
            if (user.total_count) {
                totalHits = user.total_count.total || 0;
                critHits = user.total_count.critical || 0;
            } else if (user.stats) {
                totalHits = user.stats.total || 0;
                critHits = user.stats.critical || 0;
            } else {
                return '0.0';
            }
            
            if (totalHits === 0) return '0.0';
            return ((critHits / totalHits) * 100).toFixed(1);
        },

        calculateOverallLuckRate(user) {
            if (!user) return '0.0';
            
            // Try to get from total_count if available, otherwise fall back to stats
            let totalHits, luckHits;
            
            if (user.total_count) {
                totalHits = user.total_count.total || 0;
                luckHits = user.total_count.lucky || 0;
            } else if (user.stats) {
                totalHits = user.stats.total || 0;
                luckHits = user.stats.lucky || 0;
            } else {
                return '0.0';
            }
            
            if (totalHits === 0) return '0.0';
            return ((luckHits / totalHits) * 100).toFixed(1);
        },

        renderSkillsList(skillsData, user) {
            if (!skillsData || !skillsData.skills) {
                return '<div class="no-skills">No skill data available</div>';
            }

            // For Tank tab, we want to show damage taken timeline in the future
            // For now, show regular skills but with a note about tank-specific data
            if (State.activeTab === CONFIG.TABS.TANK) {
                return this.renderTankSkillsList(skillsData, user);
            }

            const merged = mergeSkills(skillsData.skills);
            const skillsArray = Object.entries(merged)
                .map(([id, data]) => {
                    const totalDamage = Number(data.totalDamage ?? data.total_damage ?? 0) || 0;
                    const totalHealing = Number(data.totalHealing ?? data.total_healing ?? 0) || 0;
                    const hits = data.totalCount ?? data.countBreakdown?.total ?? data.totalHits ?? data.hits ?? 0;
                    const critHits = data.critHits ?? data.critCount ?? 0;
                    const luckHits = data.luckyCount ?? data.luckHits ?? 0;
                    const maxHit = data.maxHit ?? 0;
                    const critRate = hits > 0 ? ((critHits / hits) * 100).toFixed(1) : '0.0';
                    const luckRate = hits > 0 ? ((luckHits / hits) * 100).toFixed(1) : '0.0';
                    
                    // For DPS tab, prioritize damage; for Heal tab, prioritize healing
                    let primaryValue, avgValue;
                    if (State.activeTab === CONFIG.TABS.HEAL) {
                        primaryValue = totalHealing;
                        avgValue = hits > 0 ? Math.round(totalHealing / hits) : 0;
                    } else {
                        primaryValue = totalDamage + totalHealing;
                        avgValue = hits > 0 ? Math.round((totalDamage + totalHealing) / hits) : 0;
                    }
                    
                    return {
                        id,
                        name: data.displayName || data.name || `Skill ${id}`,
                        value: primaryValue,
                        hits,
                        critRate,
                        luckRate,
                        avgValue,
                        maxHit
                    };
                })
                .filter(skill => skill.value > 0)
                .sort((a, b) => b.value - a.value);

            if (skillsArray.length === 0) {
                const tabName = State.activeTab === CONFIG.TABS.HEAL ? 'healing' : 'damage';
                return `<div class="no-skills">No ${tabName} recorded yet</div>`;
            }

            const totalValue = skillsArray.reduce((sum, skill) => sum + skill.value, 0);
            
            // Get player's class color
            const classKey = getClassKey(user?.profession);
            const baseColor = CONFIG.CLASS_COLORS[classKey] ?? CONFIG.CLASS_COLORS.default;

            return skillsArray.map(skill => {
                const percentage = totalValue > 0 ? ((skill.value / totalValue) * 100).toFixed(1) : '0.0';
                return `
                    <div class="skill-item">
                        <div class="skill-bar">
                            <div class="skill-fill" style="width: ${percentage}%; background: linear-gradient(90deg, ${baseColor}80, ${baseColor}30);"></div>
                            <div class="skill-content">
                                <div class="skill-info">
                                    <span class="skill-name">${skill.name}</span>
                                    <span class="skill-stats">
                                        ${formatNumber(skill.value)} (${percentage}%)
                                    </span>
                                </div>
                                <div class="skill-details">
                                    <span class="hits">${skill.hits} hits</span>
                                    <span class="crit">${skill.critRate}% crit</span>
                                    <span class="luck">${skill.luckRate}% luck</span>
                                    <span class="avg">${formatNumber(skill.avgValue)} avg</span>
                                    <span class="max">${formatNumber(skill.maxHit)} max</span>
                                </div>
                            </div>
                        </div>
                    </div>
                `;
            }).join('');
        },

        renderTankSkillsList(skillsData, user) {
            // For Tank tab, show damage taken timeline instead of player's own skills
            if (!user) {
                return '<div class="no-skills">No user data available</div>';
            }

            const damageTakenTimeline = skillsData?.damageTakenTimeline || [];
            
            if (damageTakenTimeline.length === 0) {
                return `
                    <div class="no-skills">
                        <div>No damage taken events in the last 60 seconds</div>
                        <div style="font-size: 0.9em; color: #888; margin-top: 8px;">
                            Timeline will show 1-second windows with:<br>
                            • Damage amount and source<br>
                            • Skill IDs that caused damage<br>
                            • Timestamp relative to encounter start
                        </div>
                    </div>
                `;
            }

            // Get player's class color for the bars
            const classKey = getClassKey(user?.profession);
            const baseColor = CONFIG.CLASS_COLORS[classKey] ?? CONFIG.CLASS_COLORS.default;
            
            const maxDamage = Math.max(...damageTakenTimeline.map(w => w.totalEffectiveDamage));

            const timelineHtml = damageTakenTimeline.map(window => {
                const percentage = maxDamage > 0 ? ((window.totalEffectiveDamage / maxDamage) * 100).toFixed(1) : '0.0';
                const timeText = `${window.relativeTime}s`;
                const effectiveDamage = window.totalEffectiveDamage;
                const rawDamage = window.totalRawDamage;
                const sourceCount = window.events.length;
                const sourceText = sourceCount === 1 ? "source" : "sources";
                
                // Check if this window contains a death event
                const hasDeathEvent = window.events.some(event => event.isDead);
                
                // Determine if this was fully absorbed (immune)
                const isFullyAbsorbed = effectiveDamage === 0 && rawDamage === 0 && sourceCount > 0;
                
                let absorptionText;
                if (isFullyAbsorbed) {
                    absorptionText = "Immune";
                } else {
                    // For partial or no absorption, don't show absorption details
                    absorptionText = "";
                }
                
                // Style differently for death events
                const deathStyle = hasDeathEvent ? 
                    'border-left: 4px solid #ff3333; background: linear-gradient(90deg, #ff333320, #ff333310);' : 
                    '';
                const deathIcon = hasDeathEvent ? '💀 ' : '';
                const fillColor = hasDeathEvent ? 
                    'linear-gradient(90deg, #ff3333, #ff333380)' : 
                    'linear-gradient(90deg, #ff6b6b80, #ff6b6b30)';
                
                return `
                    <div class="skill-item" style="${deathStyle}">
                        <div class="skill-bar">
                            <div class="skill-fill" style="width: ${percentage}%; background: ${fillColor};"></div>
                            <div class="skill-content">
                                <div class="skill-info">
                                    <span class="skill-name">${deathIcon}${timeText} - ${formatNumber(effectiveDamage)} HP lost${hasDeathEvent ? ' (DEATH)' : ''}</span>
                                    <span class="skill-stats">
                                        ${absorptionText ? absorptionText + " - " : ""}${sourceCount} ${sourceText}
                                    </span>
                                </div>
                            </div>
                        </div>
                    </div>
                `;
            }).join('');

            // Add death events section if there are any deaths
            const deathEvents = user.getRecentDeathEvents ? user.getRecentDeathEvents(5) : [];
            
            if (deathEvents.length > 0) {
                const deathEventsHtml = `
                    <div style="margin-top: 20px; padding-top: 15px; border-top: 1px solid #444;">
                        <div style="font-weight: bold; margin-bottom: 10px; color: #ff6b6b;">Recent Deaths</div>
                        ${deathEvents.map(event => `
                            <div class="death-event" style="background: #2a1a1a; border-left: 3px solid #ff6b6b; padding: 8px 12px; margin-bottom: 8px; border-radius: 4px;">
                                <div style="font-size: 0.9em; color: #ff6b6b; font-weight: bold;">
                                    ${event.relativeTime}s ago
                                </div>
                                <div style="font-size: 0.85em; color: #ccc; margin-top: 2px;">
                                    ${event.attackerName || 'Unknown attacker'}${event.damage > 0 ? ` • ${formatNumber(event.damage)} damage` : ''}
                                </div>
                            </div>
                        `).join('')}
                    </div>
                `;
                return timelineHtml + deathEventsHtml;
            }
            
            return timelineHtml;
        },
    };

    // ==========================================================================
    // 7) Construction payload “spells” + fenêtre
    //    SRP: tout ce qui concerne l’affichage/transport des détails de sorts.
    //    DIP: n’accède pas directement à io, seulement à window/document fournis.
    // ==========================================================================

    const Spells = {
        buildSpellPayload(userId) {
            const user = State.users[userId];
            const entry = State.skillsByUser[userId];
            //console.log(entry);
            if (!user || !entry?.skills) return null;

            const merged = mergeSkills(entry.skills);
            const items = Object.entries(merged)
                .map(([id, d]) => {
                    const totalDamage = Number(d.totalDamage ?? d.total_damage ?? 0) || 0;
                    const totalHealing = Number(d.totalHealing ?? d.total_healing ?? 0) || 0;
                    // ✅ ajoute toutes les sources possibles de "casts"
                    const casts = d.totalCount ?? d.countBreakdown?.total ?? d.totalHits ?? d.hits ?? 0;

                    const hits = casts; // on aligne "hits" sur "casts" pour compat descendante
                    const critHits = d.critCount ?? d.critHits ?? 0;

                    return {
                        id,
                        name: d.displayName || id,
                        type: (d.type || "").toLowerCase(),     // "healing" / "damage"
                        damage: totalDamage,
                        heal: totalHealing,
                        totalDamage: totalDamage,
                        totalHealing: totalHealing,
                        casts,                                   // <<--- NOUVEAU
                        hits,                                    // conservé pour l'ancien details.html
                        critHits,
                        avg: hits > 0 ? totalDamage / hits : 0,
                        critRate: hits > 0 ? (critHits / hits) * 100 : 0,
                        countBreakdown: d.countBreakdown || null // optionnel, utile au debug
                    };
                })
                .filter(x => (x.damage || x.heal) > 0);

            const total = items.reduce((s, i) => s + (i.damage || 0), 0) || 1;
            const classKey = getClassKey(user.profession);
            return { user, items, total, classKey };
        },

        bringWindowToFront() {
            try { State.spellWindowRef?.focus?.(); } catch { }
            setTimeout(() => { try { State.spellWindowRef?.focus?.(); } catch { } }, 0);
            try { window.focus(); } catch { }
            try { window.electronAPI?.focusChildWindow?.("SpellDetails"); } catch { }
        },

        closeWindowIfAny() {
            try { State.spellWindowRef?.close?.(); } catch { }
            State.spellWindowRef = null;
            State.currentSpellUserId = null;
            if (State.spellWindowWatchdog) { clearInterval(State.spellWindowWatchdog); State.spellWindowWatchdog = null; }
        },

        // --- Spells.openWindowForUser : réouverture + focus fiable
        openWindowForUser(userId) {
            State.currentSpellUserId = userId;

            const DETAILS_URL = "./details/index.html";
            const NAME = "SpellDetails";

            // (ré)ouvre ou réutilise la fenêtre
            if (!State.spellWindowRef || State.spellWindowRef.closed) {
                State.spellWindowRef = window.open(
                    DETAILS_URL,
                    NAME,
                    "popup,width=780,height=720,menubar=0,toolbar=0,location=0,status=0,resizable=1"
                );

                // watchdog pour nettoyer l’état si l’utilisateur ferme la fenêtre
                if (State.spellWindowWatchdog) clearInterval(State.spellWindowWatchdog);
                State.spellWindowWatchdog = window.setInterval(() => {
                    if (!State.spellWindowRef || State.spellWindowRef.closed) Spells.closeWindowIfAny();
                }, 1000);
            }

            // => toujours amener au premier plan (renderer + IPC)
            try { window.focus(); } catch { }
            Spells.bringWindowToFront?.();
            try { window.electronAPI?.focusChildWindow?.(NAME); } catch { }

            const payload = Spells.buildSpellPayload(userId);
            if (!payload) return;

            // --- Handshake: on attend "details-ready", puis on envoie le payload ---
            let sent = false;
            const send = () => {
                if (sent || !State.spellWindowRef || State.spellWindowRef.closed) return;
                try {
                    State.spellWindowRef.postMessage({ type: "spell-data", payload }, location.origin);
                    sent = true;
                } catch {
                    setTimeout(send, 120);
                }
            };

            const onReady = (ev) => {
                if (ev.source !== State.spellWindowRef) return;
                if (ev?.data?.type === "details-ready") {
                    window.removeEventListener("message", onReady);
                    send();
                }
            };
            window.addEventListener("message", onReady);

            // filet de sécurité si le "ready" se perd
            setTimeout(send, 200);
        },

        pushLiveUpdateIfActive(userId) {
            if (!State.spellWindowRef || State.spellWindowRef.closed) return;
            if (State.currentSpellUserId !== userId) return;
            const payload = Spells.buildSpellPayload(userId);
            if (!payload) return;
            State.spellWindowRef.postMessage({ type: "spell-data", payload }, "*");
        },
    };

    // ==========================================================================
    // 8) Gestion des données (adaptateurs) — SRP: mutation d’état + triggers UI
    // ==========================================================================

    const Data = {
        updateAll() {
            const users = Object.values(State.users).filter((u) =>
                (State.activeTab === CONFIG.TABS.DPS && u.total_dps > 0) ||
                (State.activeTab === CONFIG.TABS.HEAL && u.total_hps > 0) ||
                (State.activeTab === CONFIG.TABS.TANK && u.taken_damage > 0)
            );
            Renderer.renderDataList(users, State.activeTab);
        },

        processDataUpdate(data) {
            if (State.paused || !data?.user) return;

            for (const [userId, newUser] of Object.entries(data.user)) {
                const existing = State.users[userId] ?? {};
                State.users[userId] = {
                    ...existing,
                    ...newUser,
                    id: userId,
                    name: newUser.name && newUser.name !== "未知" ? newUser.name : (existing.name || "..."),
                    profession: newUser.profession || existing.profession || "",
                    fightPoint: newUser.fightPoint ?? existing.fightPoint ?? 0,
                };
            }

            if (data.skills) {
                for (const [userId, skills] of Object.entries(data.skills)) {
                    if (skills) State.skillsByUser[userId] = skills;
                }
            }

            Data.updateAll();

            if (State.currentSpellUserId) {
                const touchedUsers = Object.keys(data.user || {});
                const touchedSkills = Object.keys(data.skills || {});
                if (touchedUsers.includes(State.currentSpellUserId) || touchedSkills.includes(State.currentSpellUserId)) {
                    Spells.pushLiveUpdateIfActive(State.currentSpellUserId);
                }
            }
        },
    };

    // ==========================================================================
    // 9) UI actions (contrôleurs)
    //    SRP: actions utilisateur + orchestration d’autres modules.
    // ==========================================================================

    const UI = {
        togglePause() {
            State.paused = !State.paused;
            Dom.pauseBtn.textContent = State.paused ? "Resume" : "Pause";
            setServerStatus(State.paused ? "paused" : "connected");
            try {
                if (State.paused) showNotification('Paused', 2000);
                else showNotification('Resumed', 1400);
            } catch (e) { }
        },

        async clearData() {
            // show sticky notification while clearing/saving
            try {
                const prev = getServerStatus();
                setServerStatus("cleared");

                const resp = await fetch(`http://${CONFIG.SERVER_URL}/api/clear`);
                if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
                const result = await resp.json();

                if (result.code === 0) {
                    State.users = {};
                    State.skillsByUser = {};
                    Data.updateAll();
                    UI.resetSpellPopup();
                    Spells.closeWindowIfAny();
                    //console.log("Data cleared successfully.");
                    // replace sticky message with success
                    try { showNotification && showNotification('Cleared', 2000); } catch (e) { }
                } else {
                    console.error("Failed to clear data:", result.msg);
                    try { showNotification && showNotification('Clear failed', 3000); } catch (e) { }
                }

                setTimeout(() => setServerStatus(prev), 1000);
            } catch (err) {
                console.error("Clear error:", err);
                setServerStatus("disconnected");
                try { showNotification && showNotification('Clear failed', 3000); } catch (e) { }
            }
        },

        toggleSettings() {
            const visible = !Dom.settings.classList.contains("hidden");
            Dom.settings.classList.toggle("hidden", visible);
            Dom.columns.classList.toggle("hidden", !visible);
            Dom.help.classList.add("hidden");
        },

        toggleHelp() {
            const visible = !Dom.help.classList.contains("hidden");
            Dom.help.classList.toggle("hidden", visible);
            Dom.columns.classList.toggle("hidden", !visible);
            Dom.settings.classList.add("hidden");
        },

        closeClient() {
            window.electronAPI?.closeClient?.();
        },

        // --- Popup inline (gardé comme fallback “propre”) ---
        resetSpellPopup() {
            Dom.popup.list?.replaceChildren?.();
            const tbody = document.getElementById("spellTbody");
            const summary = document.getElementById("spellSummary");
            const footer = document.getElementById("spellFooter");
            const popupEl = Dom.popup.container;

            if (tbody) tbody.replaceChildren();
            if (summary) summary.replaceChildren();
            Dom.popup.title.textContent = "";
            if (footer) footer.textContent = "—";
            if (popupEl) popupEl.classList.add("hidden");
        },

        showPopupForUser(userId) {
            if (CONFIG.OPEN_SPELLS_IN_WINDOW) {
                const payload = Spells.buildSpellPayload(userId);
                if (!payload) { console.warn("Aucune compétence pour", userId); return; }
                Spells.openWindowForUser(userId);
                return;
            }
            console.warn("Popup inline non utilisé (OPEN_SPELLS_IN_WINDOW=false).");
        },

        showLiveSkillsForUser(userId, userName) {
            State.viewMode = "live-skills";
            State.liveSkillsUserId = userId;
            State.liveSkillsUserName = userName;
            
            // Trigger re-render to show live skills view
            Renderer.renderLiveSkillsView();
            
            // Show notification
            try {
                showNotification(`Viewing ${userName}'s live skills`, 2000);
            } catch (e) { }
        },

        closePopup() {
            Dom.popup.container.classList.add("hidden");
        },
    };

    // -------------------- Notifications (bottom bubble) --------------------
    let __notifTimer = null;
    function _getNotifEls() {
        const el = document.getElementById('notification');
        const msg = el ? el.querySelector('.notification-msg') : null;
        return { el, msg };
    }

    function showNotification(text, duration = 3000) {
        const { el, msg } = _getNotifEls();
        if (!el || !msg) return;
        // ensure visible (remove hidden), set message
        msg.textContent = text || '';
        el.classList.remove('hidden');
        // small delay to allow CSS to reflow then add show class
        requestAnimationFrame(() => el.classList.add('show'));

        if (__notifTimer) { clearTimeout(__notifTimer); __notifTimer = null; }
        if (duration && duration > 0) {
            __notifTimer = setTimeout(() => {
                hideNotification();
            }, duration);
        }
    }

    function hideNotification() {
        const { el } = _getNotifEls();
        if (!el) return;
        el.classList.remove('show');
        if (__notifTimer) { clearTimeout(__notifTimer); __notifTimer = null; }
        // after transition, hide completely to remove from accessibility tree
        setTimeout(() => { try { el.classList.add('hidden'); } catch (e) { } }, 260);
    }

    // ==========================================================================
    // 10) WebSocket layer
    //     DIP: dépendance à io() injectée via global window.io disponible.
    // ==========================================================================

    const WS = {
        connect(ioFactory = window.io) {
            State.socket = ioFactory(`ws://${CONFIG.SERVER_URL}`);

            State.socket.on("connect", () => {
                State.wsConnected = true;
                setServerStatus("connected");
                State.lastWsMessageTs = Date.now();
            });

            State.socket.on("disconnect", () => {
                State.wsConnected = false;
                setServerStatus("disconnected");
            });

            State.socket.on("data", (data) => {
                if (!window.__sessionStartTs) window.__sessionStartTs = Date.now();
                window.__lastUpdateTs = Date.now();

                Data.processDataUpdate(data);
                State.lastWsMessageTs = Date.now();
            });

            State.socket.on("user_deleted", ({ uid }) => {
                delete State.users[uid];
                delete State.skillsByUser[uid];
                Data.updateAll();
                if (State.currentSpellUserId === uid) Spells.closeWindowIfAny();
                
                // If the currently viewed user in live skills is deleted, return to main view
                if (State.liveSkillsUserId === uid) {
                    State.viewMode = "main";
                    State.liveSkillsUserId = null;
                    State.liveSkillsUserName = null;
                    try {
                        showNotification('Player left, returning to main view', 2000);
                    } catch (e) { }
                }
            });

            State.socket.on("connect_error", (err) => {
                console.error("WebSocket error:", err);
                setServerStatus("disconnected");
            });

            State.socket.on('session_started', (data) => {
                try { showNotification('Loading New Instance', 1600); } catch (e) { }
                setServerStatus('cleared');
                State.users = {};
                Renderer.renderDataList([], State.activeTab);
            });

            State.socket.on('session_changed', (data) => {
                try { showNotification('Loading New Instance', 1600); } catch (e) { }
                setServerStatus('cleared');
                State.users = {};
                Renderer.renderDataList([], State.activeTab);
            });
        },

        checkConnection() {
            const elapsed = Date.now() - State.lastWsMessageTs;

            if (!State.wsConnected && State.socket?.disconnected) {
                setServerStatus("reconnecting");
                State.socket.connect();
            }

            if (elapsed > CONFIG.WS_RECONNECT_MS) {
                State.wsConnected = false;
                State.socket?.disconnect();
                WS.connect();
                setServerStatus("reconnecting");
            }
        },
    };

    // ==========================================================================
    // 11) Bootstrap (composition racine) — orchestre les modules
    // ==========================================================================

    function bootstrap() {
        WS.connect();
        setInterval(WS.checkConnection, CONFIG.WS_RECONNECT_MS);

        Dom.tabButtons.forEach((btn) => {
            btn.addEventListener("click", () => {
                State.activeTab = /** @type {TabKey} */ (btn.dataset.tab);
                Dom.tabButtons.forEach((b) => b.classList.remove("active"));
                btn.classList.add("active");
                Data.updateAll();
            });
        });

        Dom.opacity.addEventListener("input", (e) => setBackgroundOpacity(e.target.value));
        setBackgroundOpacity(Dom.opacity.value);

        // show app version in Help panel
        try {
            window.electronAPI?.getAppVersion?.().then((v) => {
                try {
                    if (!v) return;
                    const help = document.getElementById('helpContainer');
                    if (help) {
                        let verEl = help.querySelector('.help-version');
                        if (!verEl) {
                            verEl = document.createElement('p');
                            verEl.className = 'help-version';
                            verEl.style.marginTop = '10px';
                            verEl.style.fontSize = '12px';
                            verEl.style.color = 'rgba(200,200,200,0.9)';
                            help.appendChild(verEl);
                        }
                        verEl.textContent = `Version: ${v}`;
                    }

                    // append version to the app title string so it appears on the same line
                    const appTitleEl = document.querySelector('.app-title');
                    if (appTitleEl) {
                        // keep original title text if present, then append version
                        const base = (appTitleEl.dataset.baseTitle || appTitleEl.textContent || 'RiceGang Meter').trim();
                        appTitleEl.dataset.baseTitle = base;
                        appTitleEl.textContent = `${base} v${v}`;
                        appTitleEl.title = `Version ${v}`;
                    }
                } catch (e) { /* ignore UI errors */ }
            }).catch(() => {});
        } catch (e) { /* noop */ }

        // Electron passthrough
        window.electronAPI?.onTogglePassthrough?.((isIgnoring) => {
            Dom.allButtons.forEach((btn) => btn.classList.toggle("hidden", isIgnoring));
            Dom.passthroughTitle.classList.toggle("hidden", !isIgnoring);
            Dom.columns.classList.remove("hidden");
            Dom.settings.classList.add("hidden");
            Dom.help.classList.add("hidden");
        });

        // Global shortcuts: Clear and Toggle Pause (from main process globalShortcut)
        window.electronAPI?.onGlobalClear?.(() => {
            try { UI.clearData(); } catch (e) { console.error('Failed to handle global clear', e); }
        });

        window.electronAPI?.onGlobalTogglePause?.(() => {
            try { UI.togglePause(); } catch (e) { console.error('Failed to handle global toggle pause', e); }
        });

        // Hotkeys settings UI wiring
        const pauseInput = document.getElementById('pauseHotkeyInput');
        const clearInput = document.getElementById('clearHotkeyInput');
        const saveBtn = document.getElementById('saveHotkeys');
        const restoreBtn = document.getElementById('restoreHotkeys');

        function populateHotkeyInputs(hk) {
            try {
                const pause = (hk && hk.pause) || (window.__initialHotkeys && window.__initialHotkeys.pause) || 'PageUp';
                const clear = (hk && hk.clear) || (window.__initialHotkeys && window.__initialHotkeys.clear) || 'PageDown';
                if (pauseInput) pauseInput.value = pause;
                if (clearInput) clearInput.value = clear;
            } catch (e) { /* ignore */ }
        }

        // Load current hotkeys from main
        try {
            window.electronAPI?.getHotkeys?.().then((hk) => {
                populateHotkeyInputs(hk || {});
                // cache
                window.__initialHotkeys = hk || {};
            }).catch(() => populateHotkeyInputs(null));
        } catch (e) { populateHotkeyInputs(null); }

        // Save handler
        if (saveBtn) saveBtn.addEventListener('click', async () => {
            const newPause = pauseInput?.value?.trim() || '';
            const newClear = clearInput?.value?.trim() || '';
            try {
                await window.electronAPI?.setHotkeys?.({ pause: newPause, clear: newClear });
                try { showNotification('Settings Updated!', 1800); } catch (e) { }
            } catch (err) {
                console.error('Failed to save hotkeys', err);
                try { showNotification('Save failed', 2500); } catch (e) { }
            }
        });

        // Restore defaults
        if (restoreBtn) restoreBtn.addEventListener('click', async () => {
            try {
                await window.electronAPI?.setHotkeys?.({ pause: 'PageUp', clear: 'PageDown' });
                try { showNotification('Defaults restored', 1400); } catch (e) { }
            } catch (err) { console.error('Failed to restore hotkeys', err); try { showNotification('Restore failed', 2500); } catch (e) { } }
        });

        // Update UI when hotkeys change elsewhere
        window.electronAPI?.onHotkeysChanged?.((hk) => {
            populateHotkeyInputs(hk || {});
        });

        // --- Key capture modal for assigning hotkeys (click input -> press any key) ---
        const keyModal = document.getElementById('keyCaptureModal');
        let keyCaptureTarget = null;

        function formatAcceleratorFromEvent(ev) {
            // Ignore pure modifier key presses until user presses a non-mod key.
            if (!ev || !ev.key) return null;
            const key = ev.key;
            if (['Shift', 'Control', 'Alt', 'Meta'].includes(key)) return null;

            const parts = [];
            if (ev.ctrlKey) parts.push('Control');
            if (ev.metaKey) parts.push('Meta');
            if (ev.altKey) parts.push('Alt');
            if (ev.shiftKey) parts.push('Shift');

            let main = key;
            if (main === ' ') main = 'Space';
            // Normalize single char to uppercase
            if (main.length === 1) main = main.toUpperCase();

            parts.push(main);
            return parts.join('+');
        }

        function keyCaptureHandler(ev) {
            try {
                ev.preventDefault();
                ev.stopPropagation();
            } catch (e) { }

            if (!keyCaptureTarget) return closeKeyCapture();
            if (ev.key === 'Escape') return closeKeyCapture();

            const accel = formatAcceleratorFromEvent(ev);
            if (!accel) {
                // Wait for a non-modifier key
                return;
            }

            // Put the captured accelerator in the input (but DO NOT save yet)
            keyCaptureTarget.value = accel;
            closeKeyCapture();
        }

        function openKeyCapture(inputEl) {
            if (!inputEl || !keyModal) return;
            keyCaptureTarget = inputEl;
            keyModal.classList.remove('hidden');
            // small delay to ensure modal painted before listening
            setTimeout(() => document.addEventListener('keydown', keyCaptureHandler, { capture: true }), 10);
        }

        function closeKeyCapture() {
            if (keyModal) keyModal.classList.add('hidden');
            try { document.removeEventListener('keydown', keyCaptureHandler, { capture: true }); } catch (e) { }
            keyCaptureTarget = null;
        }

        // Attach click handlers to the hotkey inputs so clicks open the capture modal
        try {
            if (pauseInput) pauseInput.addEventListener('click', () => openKeyCapture(pauseInput));
            if (clearInput) clearInput.addEventListener('click', () => openKeyCapture(clearInput));
            // also allow clicking the modal overlay to cancel
            if (keyModal) keyModal.addEventListener('click', (ev) => {
                if (ev.target === keyModal) closeKeyCapture();
            });
        } catch (e) { /* ignore attach errors */ }

        // Hotkeys Settings UI
        (async function setupHotkeysUI() {
            const pauseInput = document.getElementById('pauseHotkeyInput');
            const clearInput = document.getElementById('clearHotkeyInput');
            const saveBtn = document.getElementById('saveHotkeysBtn');
            const restoreBtn = document.getElementById('restoreHotkeysBtn');
            const statusEl = document.getElementById('hotkeysStatus');

            async function load() {
                try {
                    const h = await (window.electronAPI?.getHotkeys?.() ?? Promise.resolve({}));
                    if (pauseInput) pauseInput.value = h.pause || '';
                    if (clearInput) clearInput.value = h.clear || '';
                } catch (e) { console.error('Failed to load hotkeys', e); }
            }

            function showStatus(txt, timeout = 2000) {
                if (!statusEl) return;
                statusEl.textContent = txt;
                setTimeout(() => { statusEl.textContent = ''; }, timeout);
            }

            if (saveBtn) saveBtn.addEventListener('click', async () => {
                const pauseVal = pauseInput?.value?.trim() || '';
                const clearVal = clearInput?.value?.trim() || '';
                try {
                    await window.electronAPI?.setHotkeys?.({ pause: pauseVal, clear: clearVal });
                    showStatus('Hotkeys saved');
                } catch (e) {
                    console.error('Failed to save hotkeys', e);
                    showStatus('Save failed');
                }
            });

            if (restoreBtn) restoreBtn.addEventListener('click', async () => {
                try {
                    // restore defaults: PageUp/PageDown
                    await window.electronAPI?.setHotkeys?.({ pause: 'PageUp', clear: 'PageDown' });
                    await load();
                    showStatus('Defaults restored');
                } catch (e) { console.error('Failed to restore defaults', e); showStatus('Restore failed'); }
            });

            // listen for runtime changes
            window.electronAPI?.onHotkeysChanged?.((h) => {
                if (pauseInput && h.pause) pauseInput.value = h.pause;
                if (clearInput && h.clear) clearInput.value = h.clear;
            });

            await load();
        })();
        document.getElementById("closePopupButton")?.addEventListener("click", UI.closePopup);
    }

    document.addEventListener("DOMContentLoaded", bootstrap);

    // Fournit au module sessions.js une lecture *readonly* de l'état courant.
    function __getOverlayData() {
        // on clone pour éviter toute mutation externe
        const users = JSON.parse(JSON.stringify(State.users));
        const skillsByUser = JSON.parse(JSON.stringify(State.skillsByUser));
        return { users, skillsByUser };
    }

    // === Fenêtre "Sessions" (historique) ===
    const SessionsOverlay = (() => {
        let win = null;
        let watchdog = null;

        // --- SessionsOverlay.open : réouverture + focus fiable
        function open() {
            const url = "./sessions/index.html";
            const NAME = "SessionsWindow";

            if (!win || win.closed) {
                win = window.open(
                    url,
                    NAME,
                    "popup,width=1200,height=940,menubar=0,toolbar=0,location=0,status=0,resizable=1"
                );
                if (watchdog) clearInterval(watchdog);
                watchdog = setInterval(() => {
                    if (!win || win.closed) { win = null; clearInterval(watchdog); watchdog = null; }
                }, 1000);
            }

            // => toujours amener au premier plan (renderer + IPC)
            try { window.focus(); } catch { }
            try { win?.focus?.(); } catch { }
            setTimeout(() => { try { win?.focus?.(); } catch { } }, 0);
            try { window.electronAPI?.focusChildWindow?.(NAME); } catch { }
        }


        // Le child nous demande d’enregistrer une session (car lui n’a pas accès à l’état runtime)
        window.addEventListener("message", async (ev) => {
            if (!ev?.data) return;
            const { type } = ev.data;
            if (type === "save-session") {
                try {
                    const id = await window.Sessions?.saveCurrentSession?.();
                    ev.source?.postMessage?.({ type: "session-saved", id }, "*");
                } catch (e) {
                    ev.source?.postMessage?.({ type: "session-save-error", error: String(e) }, "*");
                }
            }
        });

        return { open };
    })();

    // wiring du bouton (au DOMContentLoaded déjà existant si tu en as un)
    document.addEventListener("DOMContentLoaded", () => {
        document.getElementById("btnOpenSessions")?.addEventListener("click", () => {
            SessionsOverlay.open();
        });
    });


    // ==========================================================================
    // 12) API publique (facilite les tests / interactions externes)
    // ==========================================================================

    Object.assign(window, {
        clearData: UI.clearData,
        togglePause: UI.togglePause,
        toggleSettings: UI.toggleSettings,
        toggleHelp: UI.toggleHelp,
        closeClient: UI.closeClient,
        showPopupForUser: UI.showPopupForUser,
        showLiveSkillsForUser: UI.showLiveSkillsForUser,
        closePopup: UI.closePopup,
        getOverlayData: __getOverlayData
    });
})();