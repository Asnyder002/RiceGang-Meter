import { globalShortcut } from 'electron';
import window from './Window.js';

const RESIZE_INCREMENT = 20;
const MOVE_INCREMENT = 20;

// Default accelerator bindings (can be overridden via settings)
const DEFAULT_HOTKEYS = {
    pause: 'PageUp',
    clear: 'PageDown',
};

let currentHotkeys = { ...DEFAULT_HOTKEYS };

/**
 * Registers all global keyboard shortcuts for the application.
 */
export function registerShortcuts() {
    // Register core shortcuts
    registerPassthrough();
    registerResize();
    registerMove();
    registerMinimize();
    // Register clear/pause using configured hotkeys
    registerClearPause();
}

/**
 * Registers the shortcut for toggling mouse event pass-through.
 */
function registerPassthrough() {
    globalShortcut.register('Control+`', () => {
        window.togglePassthrough();
    });
}

/**
 * Registers shortcuts for resizing the window.
 */
function registerResize() {
    globalShortcut.register('Control+Up', () => {
        const [width, height] = window.getSize();
        const newHeight = Math.max(40, height - RESIZE_INCREMENT);
        window.setSize(width, newHeight);
    });

    globalShortcut.register('Control+Down', () => {
        const [width, height] = window.getSize();
        window.setSize(width, height + RESIZE_INCREMENT);
    });

    globalShortcut.register('Control+Left', () => {
        const [width, height] = window.getSize();
        const newWidth = Math.max(280, width - RESIZE_INCREMENT);
        window.setSize(newWidth, height);
    });

    globalShortcut.register('Control+Right', () => {
        const [width, height] = window.getSize();
        window.setSize(width + RESIZE_INCREMENT, height);
    });
}

/**
 * Registers shortcuts for moving the window.
 */
function registerMove() {
    globalShortcut.register('Control+Alt+Up', () => {
        const [x, y] = window.getPosition();
        window.setPosition(x, y - MOVE_INCREMENT);
    });

    globalShortcut.register('Control+Alt+Down', () => {
        const [x, y] = window.getPosition();
        window.setPosition(x, y + MOVE_INCREMENT);
    });

    globalShortcut.register('Control+Alt+Left', () => {
        const [x, y] = window.getPosition();
        window.setPosition(x - MOVE_INCREMENT, y);
    });

    globalShortcut.register('Control+Alt+Right', () => {
        const [x, y] = window.getPosition();
        window.setPosition(x + MOVE_INCREMENT, y);
    });
}

/**
 * Registers the shortcut for minimizing/restoring the window height.
 */
function registerMinimize() {
    globalShortcut.register('Control+Alt+Z', () => {
        window.minimizeOrRestore();
    });
}

/**
 * Registers shortcuts for global Clear and Pause actions.
 * These send IPC messages to the renderer so the actions run even when
 * another window is focused.
 */
function registerClearPause() {
    try {
        // unregister previous if any
        try { globalShortcut.unregister(currentHotkeys.clear); } catch {}
        try { globalShortcut.unregister(currentHotkeys.pause); } catch {}

        const cfg = window.config && window.config.hotkeys ? window.config.hotkeys : {};
        const clearAccel = cfg.clear || currentHotkeys.clear || DEFAULT_HOTKEYS.clear;
        const pauseAccel = cfg.pause || currentHotkeys.pause || DEFAULT_HOTKEYS.pause;

        if (clearAccel) {
            globalShortcut.register(clearAccel, () => {
                try {
                    const bw = window.getWindow?.();
                    if (bw && bw.webContents) bw.webContents.send('global-clear');
                } catch (e) { /* swallow */ }
            });
        }

        if (pauseAccel) {
            globalShortcut.register(pauseAccel, () => {
                try {
                    const bw = window.getWindow?.();
                    if (bw && bw.webContents) bw.webContents.send('global-toggle-pause');
                } catch (e) { /* swallow */ }
            });
        }
    } catch (err) {
        // globalShortcut.register may throw if not allowed on platform; ignore
        console.error('Failed to register clear/pause shortcuts', err);
    }
}

/** Replace current hotkeys and re-register clear/pause */
export function setHotkeys(hotkeys = {}) {
    currentHotkeys = { ...currentHotkeys, ...hotkeys };
    registerClearPause();
}

export function getHotkeys() {
    const cfg = window.config && window.config.hotkeys ? window.config.hotkeys : {};
    return {
        pause: cfg.pause || currentHotkeys.pause,
        clear: cfg.clear || currentHotkeys.clear,
    };
}
