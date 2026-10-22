// Test-only helper: opens the Focus panel menu in a nested/headless GNOME
// Shell and saves screenshots of each tab to $YTF_SNAP_DIR. Never installed
// by install.sh; used by gnome/test/panel-shots.sh.
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Shell from 'gi://Shell';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

Gio._promisify(Shell.Screenshot.prototype, 'screenshot');

const wait = ms => new Promise(r => GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
    r();
    return GLib.SOURCE_REMOVE;
}));

async function shot(dir, name) {
    const file = Gio.File.new_for_path(`${dir}/${name}.png`);
    const stream = file.replace(null, false, Gio.FileCreateFlags.REPLACE_DESTINATION, null);
    await new Shell.Screenshot().screenshot(false, stream);
    stream.close(null);
    console.log(`ytf-snap: ${name}`);
}

export default class SnapExtension extends Extension {
    enable() {
        const dir = GLib.getenv('YTF_SNAP_DIR');
        if (!dir)
            return;
        (async () => {
            await wait(4000);
            Main.overview.hide();
            await wait(1500);
            const ind = Main.panel.statusArea['yt-focus@alphachief13'];
            if (!ind) {
                console.log('ytf-snap: indicator missing');
                return;
            }
            if (GLib.getenv('YTF_SNAP_MODE') === 'local') {
                // No browser: opening the menu must start the local player.
                ind.menu.open();
                for (let i = 0; i < 40 && !ind._online; i++)
                    await wait(500);
                console.log(`ytf-snap: player online=${ind._online}`);
                ind._call('Toggle'); // continue the saved session
                for (let i = 0; i < 160 && ind._state?.status !== 'playing'; i++)
                    await wait(500);
                await wait(3000);
                const st = ind._state ?? {};
                console.log(`ytf-snap: local status=${st.status} backend=${st.backend} pos=${Math.round(st.position ?? 0)} label="${ind._statusLabel.text}"`);
                ind._setView({name: 'liked'});
                await wait(700);
                await shot(dir, 'panel-local');
                ind._call('Quit');
                await wait(1500);
                console.log('ytf-snap: done');
                return;
            }
            await shot(dir, 'panel-closed');
            ind.menu.open();
            await wait(1200);
            for (const [view, name] of [['liked', 'panel-liked'], ['playlists', 'panel-playlists'], ['recent', 'panel-recent']]) {
                ind._setView({name: view});
                await wait(700);
                await shot(dir, name);
            }
            ind._setView({name: 'search'});
            ind._searchEntry.text = 'arctic monkeys';
            ind._doSearch();
            await wait(2500);
            await shot(dir, 'panel-search');

            // Ad (fake-browser.py starts one): yellow bar, Skip locked, then unlocked.
            for (let i = 0; i < 30 && ind._state?.status !== 'ad'; i++)
                await wait(500);
            await wait(600);
            console.log(`ytf-snap: ad skippable=${!!ind._state?.adSkippable} skipVisible=${ind._skipBtn.visible} skipReactive=${ind._skipBtn.reactive}`);
            await shot(dir, 'panel-ad-wait');
            for (let i = 0; i < 20 && !ind._state?.adSkippable; i++)
                await wait(500);
            await wait(600);
            console.log(`ytf-snap: ad skippable=${!!ind._state?.adSkippable} skipReactive=${ind._skipBtn.reactive}`);
            await shot(dir, 'panel-ad');
            ind._skipBtn.emit('clicked', 1);
            for (let i = 0; i < 10 && ind._state?.status === 'ad'; i++)
                await wait(300);
            console.log(`ytf-snap: after skip status=${ind._state?.status} skipVisible=${ind._skipBtn.visible}`);
            console.log('ytf-snap: done');
        })().catch(e => console.log(`ytf-snap: ${e.message}\n${e.stack}`));
    }

    disable() {}
}
