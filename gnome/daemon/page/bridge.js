/**
 * Focus local player — page bridge, injected into www.youtube.com/watch
 * inside the hidden WebKitGTK view (adapted from yt-pod's bridge.js).
 *
 * Exposes `window.__yf` for the daemon and reports state back through
 * `window.webkit.messageHandlers.ytfocus`. Ads are handled by Focus's own
 * src/ads.js (injected alongside); here we only report that one is showing.
 */
(() => {
    'use strict';
    if (window.__yf)
        return;

    const post = msg => {
        try {
            window.webkit.messageHandlers.ytfocus.postMessage(JSON.stringify(msg));
        } catch (_) { /* outside WebKitGTK */ }
    };

    const cfg = {volume: 70, play: true};
    let endedFor = null; // videoId whose end was already reported
    let lastSent = 0;

    const player = () => document.getElementById('movie_player');
    const video = () => document.querySelector('#movie_player video.html5-main-video') || document.querySelector('video');
    const isAd = () => {
        const p = player();
        return !!p && (p.classList.contains('ad-showing') || p.classList.contains('ad-interrupting'));
    };

    function data() {
        try {
            return player()?.getVideoData?.() ?? {};
        } catch (_) {
            return {};
        }
    }

    const currentId = () => data().video_id || new URLSearchParams(location.search).get('v') || '';

    function state() {
        const v = video();
        const ad = isAd();
        const d = data();
        return {
            type: 'state',
            videoId: currentId(),
            title: d.title || '',
            author: d.author || '',
            ad,
            playing: !!v && !v.paused && !v.ended,
            position: v && !ad ? v.currentTime : 0,
            length: v && !ad && Number.isFinite(v.duration) ? v.duration : 0,
        };
    }

    function send(force = false) {
        const now = Date.now();
        if (!force && now - lastSent < 900)
            return;
        lastSent = now;
        post(state());
    }

    function applyVolume() {
        if (isAd())
            return; // ads.js owns mute during ads
        const p = player();
        try {
            p?.setVolume?.(cfg.volume);
            if (cfg.volume > 0)
                p?.unMute?.();
        } catch (_) { /* player not ready */ }
    }

    // Nothing is shown: always stream the smallest rendition.
    function lowQuality() {
        const p = player();
        try {
            if (p?.setPlaybackQualityRange && p.getPlaybackQuality?.() !== 'tiny')
                p.setPlaybackQualityRange('tiny', 'tiny');
        } catch (_) { /* ignore */ }
    }

    // Stop right before the end: the daemon owns the queue, not YouTube's autoplay.
    function checkEnd() {
        const v = video();
        if (!v || isAd() || !Number.isFinite(v.duration) || v.duration < 1)
            return;
        const id = currentId();
        if (endedFor === id)
            return;
        if (v.ended || v.duration - v.currentTime < 0.4) {
            endedFor = id;
            v.pause();
            post({type: 'ended', videoId: id});
        }
    }

    // "Video paused. Continue watching?" — confirm it.
    function dismissYouThere() {
        const btn = document.querySelector('yt-confirm-dialog-renderer #confirm-button button, yt-confirm-dialog-renderer #confirm-button');
        if (btn && btn.offsetParent !== null) {
            btn.click();
            if (cfg.play)
                player()?.playVideo?.();
        }
    }

    let hooked = null;
    function hookVideo() {
        const v = video();
        if (!v || v === hooked)
            return;
        hooked = v;
        for (const ev of ['play', 'pause', 'loadedmetadata', 'durationchange', 'seeked'])
            v.addEventListener(ev, () => send(true));
        v.addEventListener('timeupdate', () => {
            checkEnd();
            send();
        });
        v.addEventListener('ended', checkEnd);
        v.addEventListener('playing', () => {
            applyVolume();
            lowQuality();
        });
    }

    window.__yf = {
        config(c) {
            Object.assign(cfg, c);
            applyVolume();
            if (cfg.play && video()?.paused && !isAd())
                player()?.playVideo?.();
            send(true);
        },
        // Switch songs without reloading the page; false = player not ready.
        load(videoId, start = 0) {
            const p = player();
            if (!p?.loadVideoById)
                return false;
            endedFor = null;
            cfg.play = true;
            p.loadVideoById({videoId, startSeconds: Math.max(0, Number(start) || 0)});
            return true;
        },
        play() {
            cfg.play = true;
            player()?.playVideo?.();
        },
        pause() {
            cfg.play = false;
            player()?.pauseVideo?.();
        },
        seek(seconds) {
            const v = video();
            if (!v || isAd())
                return;
            endedFor = null;
            const target = Math.max(0, Math.min(seconds, (v.duration || seconds) - 0.5));
            player()?.seekTo?.(target, true);
            send(true);
        },
        setVolume(vol) {
            cfg.volume = Math.max(0, Math.min(100, Math.round(vol)));
            applyVolume();
            send(true);
        },
        next() {
            endedFor = null;
            player()?.nextVideo?.();
        },
        state,
    };

    let lastAd = false;
    setInterval(() => {
        hookVideo();
        dismissYouThere();
        const ad = isAd();
        if (ad !== lastAd) {
            lastAd = ad;
            if (!ad)
                applyVolume();
            send(true);
        }
        if (!ad)
            lowQuality();
    }, 500);

    hookVideo();
    post({type: 'ready'});
})();
