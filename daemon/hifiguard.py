"""
HifiGuard — Daemon Python
Sources : NIOSH 1998 (REL 85 dB, exchange rate 3 dB)
          OMS/ITU H.870 (80 dB / 40h semaine)
          Filtre A-weighting : IEC 61672-1
"""

import sys
sys.coinit_flags = 2

# Fix encodage Windows
if hasattr(sys.stdout, 'reconfigure'):
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')
if hasattr(sys.stderr, 'reconfigure'):
    sys.stderr.reconfigure(encoding='utf-8', errors='replace')

import comtypes
import soundcard as sc
import numpy as np
import json
import csv
import os
import time
from datetime import datetime, timedelta
import scipy.signal as signal
from pycaw.pycaw import AudioUtilities

# ══════════════════════════════════════════════════════════
# CHEMINS
# ══════════════════════════════════════════════════════════
BASE_DIR    = os.path.dirname(os.path.abspath(__file__))
DATA_DIR    = os.path.join(BASE_DIR, '..', 'data')
CONFIG_PATH = os.path.join(DATA_DIR, 'config.json')
JSON_PATH   = os.path.join(DATA_DIR, 'suivi_audio.json')
CSV_PATH    = os.path.join(DATA_DIR, 'historique.csv')
STATE_PATH  = os.path.join(DATA_DIR, 'state.json')

os.makedirs(DATA_DIR, exist_ok=True)

# ══════════════════════════════════════════════════════════
# CONFIG PAR DÉFAUT
# ══════════════════════════════════════════════════════════
DEFAULT_CONFIG = {
    "active_profile": "Artti T10",
    "profiles": {
        "Artti T10": {
            "sensitivity":      96.0,
            "sensitivity_unit": "dB/mW",   # dB/mW | mV/Pa | dB/V
            "impedance":        16.5,
            "dac_vout":         1.2,
            "description":      "Artti T10 + DAC CX31993/MAX97220"
        },
        "Sennheiser HD599 SE": {
            "sensitivity":      50.0,
            "sensitivity_unit": "mV/Pa",
            "impedance":        50.0,
            "dac_vout":         1.2,
            "description":      "Sennheiser HD599 SE + DAC CX31993/MAX97220"
        }
    },
    "refresh_mode": "focus",          # focus | eco | custom
    "refresh_custom": {
        "python_ms":  25,             # intervalle bloc Python (ms)
        "ui_ms":      250,            # intervalle poll UI (ms)
        "tray_ms":    1000            # intervalle poll tray (ms)
    },
    "tray_thresholds": {
        "ok":     75,
        "warn":   80,
        "danger": 85
    }
}

# ── Presets modes ─────────────────────────────────────────
REFRESH_PRESETS = {
    "focus": { "python_ms": 25,   "ui_ms": 250,  "tray_ms": 1000 },
    "tray":  { "python_ms": 100,  "ui_ms": 1000, "tray_ms": 1000 },
    "eco":   { "python_ms": 200,  "ui_ms": 1000, "tray_ms": 2000 },
}

def load_config():
    if os.path.exists(CONFIG_PATH):
        try:
            with open(CONFIG_PATH, 'r', encoding='utf-8') as f:
                return json.load(f)
        except Exception:
            pass
    save_config(DEFAULT_CONFIG)
    return DEFAULT_CONFIG

def save_config(config):
    with open(CONFIG_PATH, 'w', encoding='utf-8') as f:
        json.dump(config, f, indent=2, ensure_ascii=False)

def get_refresh_settings(config):
    mode = config.get('refresh_mode', 'focus')
    if mode == 'custom':
        return config.get('refresh_custom', REFRESH_PRESETS['focus'])
    return REFRESH_PRESETS.get(mode, REFRESH_PRESETS['focus'])

# ══════════════════════════════════════════════════════════
# CALCUL MAX_SPL selon unité de sensibilité
# ══════════════════════════════════════════════════════════
def compute_max_spl(profile):
    """
    Convertit la sensibilité en dB/mW selon l'unité,
    puis calcule MAX_SPL depuis Vout DAC et impédance.
    """
    raw   = profile['sensitivity']
    unit  = profile.get('sensitivity_unit', 'dB/mW')
    imp   = profile['impedance']
    vout  = profile['dac_vout']

    if unit == 'dB/mW':
        sens_dbmw = raw
    elif unit == 'mV/Pa':
        # Conversion mV/Pa → dB/mW :
        # dB/mW = 20·log10(mV/Pa / 1000) + 10·log10(1000/imp) + 120
        sens_dbmw = 20*np.log10(raw/1000) + 10*np.log10(1000/imp) + 120
    elif unit == 'dB/V':
        # dB/V = dB/mW + 10·log10(imp/1000)
        # → dB/mW = dB/V - 10·log10(imp/1000)
        sens_dbmw = raw - 10*np.log10(imp/1000)
    else:
        sens_dbmw = raw

    p_max   = ((vout**2) / imp) * 1000   # mW
    max_spl = sens_dbmw + 10*np.log10(p_max)
    return max_spl, sens_dbmw

def get_active_profile(config):
    name    = config['active_profile']
    profile = config['profiles'][name]
    max_spl, sens_dbmw = compute_max_spl(profile)
    return name, profile, max_spl, sens_dbmw

# ══════════════════════════════════════════════════════════
# NORMES
# ══════════════════════════════════════════════════════════
FS                    = 44100
NIOSH_CRITERION_LEVEL = 85.0
NIOSH_CRITERION_TIME  = 480.0
WHO_WEEKLY_LIMIT_MIN  = 2400.0
WHO_DAILY_LIMIT_MIN   = 2400.0 / 7
WHO_SAFE_LEVEL        = 80.0
CEILING_DB            = 140.0
SILENCE_THRESHOLD     = 1e-5
SAVE_EVERY_N_FRAMES   = 1200    # reset selon block size en main()

# ══════════════════════════════════════════════════════════
# FILTRE A-WEIGHTING (IEC 61672-1)
# ══════════════════════════════════════════════════════════
def build_a_weighting_filter(fs):
    f1, f2, f3, f4 = 20.598997, 107.65265, 737.86223, 12194.217
    A1000 = 1.9997
    nums = [(2*np.pi*f4)**2 * A1000, 0, 0, 0, 0]
    dens = np.polymul([1, 4*np.pi*f4, (2*np.pi*f4)**2],
                      [1, 4*np.pi*f1, (2*np.pi*f1)**2])
    dens = np.polymul(dens, [1, 2*np.pi*f3])
    dens = np.polymul(dens, [1, 2*np.pi*f2])
    return signal.bilinear(nums, dens, fs)

# ══════════════════════════════════════════════════════════
# DOSE
# ══════════════════════════════════════════════════════════
def permissible_minutes_niosh(db_a):
    if db_a < 70:           return float('inf')
    if db_a >= CEILING_DB:  return 0.0
    return NIOSH_CRITERION_TIME / (2**((db_a - NIOSH_CRITERION_LEVEL)/3))

def permissible_minutes_who_day(db_a):
    if db_a < 70: return float('inf')
    return WHO_DAILY_LIMIT_MIN / (2**((db_a - WHO_SAFE_LEVEL)/3))

def permissible_minutes_who_week(db_a):
    if db_a < 70: return float('inf')
    return WHO_WEEKLY_LIMIT_MIN / (2**((db_a - WHO_SAFE_LEVEL)/3))

# ══════════════════════════════════════════════════════════
# TRACKER
# ══════════════════════════════════════════════════════════
class AudioTracker:
    def __init__(self):
        self.data = self._load_json()
        self._frame_count = 0
        # Agrégation CSV : on écrit 1 ligne/seconde avec le pic max
        self._csv_buf_z   = 0.0
        self._csv_buf_a   = 0.0
        self._csv_buf_vol = 0.0
        self._csv_buf_ts  = time.time()

    def _load_json(self):
        if os.path.exists(JSON_PATH):
            try:
                with open(JSON_PATH, 'r', encoding='utf-8') as f:
                    return json.load(f)
            except Exception:
                return {}
        return {}

    def _csv_init(self):
        if not os.path.exists(CSV_PATH):
            with open(CSV_PATH, 'w', newline='', encoding='utf-8') as f:
                csv.writer(f).writerow(['timestamp','db_z','db_a','vol_db','profile'])

    def save_json(self):
        with open(JSON_PATH, 'w', encoding='utf-8') as f:
            json.dump(self.data, f, indent=2)

    def _flush_csv(self, profile_name):
        """Écrit la ligne CSV avec le pic de la dernière seconde."""
        try:
            with open(CSV_PATH, 'a', newline='', encoding='utf-8') as f:
                csv.writer(f).writerow([
                    datetime.now().isoformat(timespec='seconds'),
                    round(self._csv_buf_z, 2),
                    round(self._csv_buf_a, 2),
                    round(self._csv_buf_vol, 2),
                    profile_name
                ])
        except Exception:
            pass
        self._csv_buf_z   = 0.0
        self._csv_buf_a   = 0.0
        self._csv_buf_ts  = time.time()

    def record(self, db_z, db_a, vol_db, profile_name, seconds, save_every):
        # Accumule le MAX sur 1 seconde puis écrit dans le CSV
        self._csv_buf_z   = max(self._csv_buf_z, db_z)
        self._csv_buf_a   = max(self._csv_buf_a, db_a)
        self._csv_buf_vol = vol_db
        if time.time() - self._csv_buf_ts >= 1.0:
            self._flush_csv(profile_name)

        # Dose — calculée à chaque frame (précision maximale)
        if db_a < 70:
            return

        today = datetime.now().strftime('%Y-%m-%d')
        if today not in self.data:
            self.data[today] = {
                'dose_niosh_pct':    0.0,
                'dose_who_day_pct':  0.0,
                'dose_who_week_pct': 0.0,
                'max_db_a':          0.0,
                'minutes_above_80':  0.0,
                'minutes_above_85':  0.0,
                'profile':           profile_name,
            }
        d = self.data[today]
        minutes = seconds / 60.0

        t_n = permissible_minutes_niosh(db_a)
        t_d = permissible_minutes_who_day(db_a)
        t_w = permissible_minutes_who_week(db_a)

        d['dose_niosh_pct']    += (minutes/t_n)*100 if t_n > 0 else 100
        d['dose_who_day_pct']  += (minutes/t_d)*100 if t_d > 0 else 100
        d['dose_who_week_pct'] += (minutes/t_w)*100 if t_w > 0 else 100
        d['max_db_a']           = max(d['max_db_a'], round(db_a, 1))
        if db_a >= 80: d['minutes_above_80'] += minutes
        if db_a >= 85: d['minutes_above_85'] += minutes

        self._frame_count += 1
        if self._frame_count % save_every == 0:
            self.save_json()

    def weekly_who_dose(self):
        today = datetime.now()
        return sum(
            self.data.get((today-timedelta(days=i)).strftime('%Y-%m-%d'), {})
                     .get('dose_who_week_pct', 0.0)
            for i in range(7)
        )

    def today_stats(self):
        return self.data.get(datetime.now().strftime('%Y-%m-%d'), {
            'dose_niosh_pct': 0.0, 'dose_who_day_pct': 0.0,
            'dose_who_week_pct': 0.0, 'max_db_a': 0.0,
            'minutes_above_80': 0.0, 'minutes_above_85': 0.0,
        })

# ══════════════════════════════════════════════════════════
# STATE.JSON — écriture sans plantage sur Windows
# ══════════════════════════════════════════════════════════
def write_state(db_a, db_z, vol_db, stats, week_who, profile_name, refresh_cfg):
    state = {
        'ts':           datetime.now().isoformat(timespec='milliseconds'),
        'db_a':         round(db_a, 1),
        'db_z':         round(db_z, 1),
        'vol_db':       round(vol_db, 1),
        'profile':      profile_name,
        'dose_niosh':   round(stats['dose_niosh_pct'], 2),
        'dose_who_j':   round(stats['dose_who_day_pct'], 2),
        'dose_who_7j':  round(week_who, 2),
        'max_db_a':     stats['max_db_a'],
        'refresh':      refresh_cfg,   # transmis à Electron pour qu'il adapte ses timers
    }
    try:
        with open(STATE_PATH, 'w', encoding='utf-8') as f:
            json.dump(state, f)
    except PermissionError:
        pass   # Electron lit le fichier, on saute cette frame

# ══════════════════════════════════════════════════════════
# AFFICHAGE CONSOLE
# ══════════════════════════════════════════════════════════
def risk_label(db_a):
    if db_a < 75: return '~ SUR    '
    if db_a < 80: return 'OK       '
    if db_a < 83: return '! MODERE '
    if db_a < 85: return '!! ELEVE '
    return              '! DANGER '

def bar(db_a, width=20):
    filled = min(int((db_a/120)*width), width)
    return '#'*filled + '.'*(width-filled)

# ══════════════════════════════════════════════════════════
# MAIN
# ══════════════════════════════════════════════════════════
def main():
    config = load_config()
    profile_name, profile, MAX_SPL, sens_dbmw = get_active_profile(config)
    refresh_cfg  = get_refresh_settings(config)
    python_ms    = refresh_cfg['python_ms']
    BLOCK_SIZE   = max(int(FS * python_ms / 1000), 256)
    seconds_per_block = BLOCK_SIZE / FS
    save_every   = max(1, int(30000 / python_ms))   # ~30s

    print('=' * 42)
    print('  HifiGuard - Daemon (NIOSH/OMS)')
    print('=' * 42)
    print(f'  Profil  : {profile_name}')
    print(f'  MAX_SPL : {MAX_SPL:.1f} dB')
    print(f'  Sensi   : {sens_dbmw:.1f} dB/mW (unit: {profile.get("sensitivity_unit","dB/mW")})')
    print(f'  Mode    : {config.get("refresh_mode","focus")} ({python_ms}ms)')
    print(f'  Data    : {DATA_DIR}')
    print('=' * 42)
    print()

    tracker = AudioTracker()
    tracker._csv_init()
    b, a = build_a_weighting_filter(FS)
    zi   = signal.lfilter_zi(b, a)

    try:
        devices = AudioUtilities.GetSpeakers()
        volume  = devices.EndpointVolume

        speaker = sc.default_speaker()
        try:
            mic = sc.get_microphone(id=speaker.name, include_loopback=True)
        except Exception:
            mic = sc.get_microphone(id=speaker.name, include_loopback=True)

        print(f'Monitoring : {mic.name}')
        print('Ctrl+C pour quitter\n')

        with mic.recorder(samplerate=FS, blocksize=BLOCK_SIZE) as recorder:
            while True:
                # Recharge config si changée (mode refresh, profil...)
                # (toutes les ~5s pour ne pas exploser le disque)
                if tracker._frame_count % max(1, int(5000/python_ms)) == 0:
                    try:
                        new_cfg = load_config()
                        if new_cfg.get('refresh_mode') != config.get('refresh_mode') or \
                           new_cfg.get('active_profile') != config.get('active_profile'):
                            config = new_cfg
                            refresh_cfg = get_refresh_settings(config)
                            python_ms   = refresh_cfg['python_ms']
                            profile_name, profile, MAX_SPL, sens_dbmw = get_active_profile(config)
                    except Exception:
                        pass

                vol_db = volume.GetMasterVolumeLevel()

                # Volume Windows à -96 dB = muet sur certains drivers
                # On considère muet si en dessous de -60 dB
                is_muted = (vol_db < -60)

                data = recorder.record(numframes=BLOCK_SIZE)
                if len(data.shape) > 1:
                    data = np.mean(data, axis=1)

                rms_raw = np.sqrt(np.mean(data**2))

                # Silence ou volume coupé → on écrit 0 dans state et on continue
                if rms_raw < SILENCE_THRESHOLD or is_muted:
                    # Si 1s écoulée pendant le silence, on flush le buffer CSV (avec 0)
                    if time.time() - tracker._csv_buf_ts >= 1.0:
                        tracker._flush_csv(profile_name)
                    stats    = tracker.today_stats()
                    week_who = tracker.weekly_who_dose()
                    write_state(0.0, 0.0, vol_db, stats, week_who, profile_name, refresh_cfg)
                    continue

                # dB brut (Z-weighting)
                db_z = max(0.0, min(
                    MAX_SPL + 20*np.log10(rms_raw + 1e-12) + vol_db,
                    CEILING_DB
                ))

                # dB(A) filtré
                data_a, zi = signal.lfilter(b, a, data, zi=zi)
                rms_a = np.sqrt(np.mean(data_a**2))
                db_a  = max(0.0, min(
                    MAX_SPL + 20*np.log10(rms_a + 1e-12) + vol_db,
                    CEILING_DB
                ))

                tracker.record(db_z, db_a, vol_db, profile_name, seconds_per_block, save_every)
                stats    = tracker.today_stats()
                week_who = tracker.weekly_who_dose()
                write_state(db_a, db_z, vol_db, stats, week_who, profile_name, refresh_cfg)

                info = (
                    f'\r{risk_label(db_a)}{bar(db_a)} '
                    f'Z:{db_z:5.1f} A:{db_a:5.1f} dB(A) | '
                    f'N:{stats["dose_niosh_pct"]:5.1f}% | '
                    f'O/j:{stats["dose_who_day_pct"]:5.1f}% | '
                    f'O/7j:{week_who:5.1f}% | '
                    f'Max:{stats["max_db_a"]:.1f}'
                )
                sys.stdout.write('\033[K' + info)
                sys.stdout.flush()

    except KeyboardInterrupt:
        tracker.save_json()
        stats = tracker.today_stats()
        print('\n\n' + '='*34)
        print('  RESUME DE SESSION')
        print('='*34)
        print(f'  Profil    : {profile_name}')
        print(f'  NIOSH/j   : {stats["dose_niosh_pct"]:.2f}%')
        print(f'  OMS/jour  : {stats["dose_who_day_pct"]:.2f}%')
        print(f'  OMS/7j    : {tracker.weekly_who_dose():.2f}%')
        print(f'  Pic max   : {stats["max_db_a"]} dB(A)')
        print(f'  >80 dB    : {stats["minutes_above_80"]:.1f} min')
        print(f'  >85 dB    : {stats["minutes_above_85"]:.1f} min')
        print('='*34)
        print('  Sauvegarde. A la prochaine !')

    except Exception as e:
        print(f'\nErreur : {e}')
        import traceback
        traceback.print_exc()

if __name__ == '__main__':
    main()
