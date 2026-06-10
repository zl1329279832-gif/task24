/* ============================================================
   history.js  –  Undo/Redo with command pattern
   ============================================================ */
const History = (() => {
    const _undoStack = [];
    const _redoStack = [];
    const MAX_HISTORY = 50;
    let _listeners = [];

    function on(fn) { _listeners.push(fn); }
    function _notify() { _listeners.forEach(fn => fn()); }

    function pushState(label) {
        const snapshot = DataModel.getSnapshot();
        _undoStack.push({ label, snapshot });
        if (_undoStack.length > MAX_HISTORY) _undoStack.shift();
        _redoStack.length = 0;
        _notify();
    }

    function undo() {
        if (_undoStack.length === 0) return false;
        const current = DataModel.getSnapshot();
        const prev = _undoStack.pop();
        _redoStack.push({ label: prev.label, snapshot: current });
        DataModel.restoreSnapshot(prev.snapshot);
        Scheduler.calculateCPM(DataModel.getTasks());
        _notify();
        return true;
    }

    function redo() {
        if (_redoStack.length === 0) return false;
        const current = DataModel.getSnapshot();
        const next = _redoStack.pop();
        _undoStack.push({ label: next.label, snapshot: current });
        DataModel.restoreSnapshot(next.snapshot);
        Scheduler.calculateCPM(DataModel.getTasks());
        _notify();
        return true;
    }

    function canUndo() { return _undoStack.length > 0; }
    function canRedo() { return _redoStack.length > 0; }
    function clear() { _undoStack.length = 0; _redoStack.length = 0; _notify(); }

    return { on, pushState, undo, redo, canUndo, canRedo, clear };
})();
