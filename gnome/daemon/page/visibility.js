/**
 * Focus local player — injected at document start (from yt-pod).
 *
 * A janela do player fica escondida, e o WebKit então pausa o
 * requestAnimationFrame e marca a página como "hidden". O player do YouTube
 * usa rAF para agendar o download do áudio, o que travaria a música depois
 * de alguns segundos de buffer. Aqui fingimos que a página está visível e
 * trocamos o rAF por um timer enquanto ela estiver de fato escondida.
 */
(() => {
    'use strict';
    const proto = Document.prototype;
    const realState = Object.getOwnPropertyDescriptor(proto, 'visibilityState').get;
    const reallyHidden = () => realState.call(document) !== 'visible';

    Object.defineProperty(proto, 'visibilityState', {configurable: true, get: () => 'visible'});
    Object.defineProperty(proto, 'hidden', {configurable: true, get: () => false});
    if ('webkitHidden' in proto)
        Object.defineProperty(proto, 'webkitHidden', {configurable: true, get: () => false});
    // Não deixa o player saber que a aba "sumiu".
    for (const ev of ['visibilitychange', 'webkitvisibilitychange'])
        document.addEventListener(ev, e => e.stopImmediatePropagation(), true);

    const realRaf = window.requestAnimationFrame.bind(window);
    const realCancel = window.cancelAnimationFrame.bind(window);
    const timers = new Map();
    let nextId = 1e9;

    window.requestAnimationFrame = cb => {
        if (!reallyHidden())
            return realRaf(cb);
        const id = nextId++;
        timers.set(id, setTimeout(() => {
            timers.delete(id);
            cb(performance.now());
        }, 33));
        return id;
    };
    window.cancelAnimationFrame = id => {
        if (timers.has(id)) {
            clearTimeout(timers.get(id));
            timers.delete(id);
        } else {
            realCancel(id);
        }
    };
})();
