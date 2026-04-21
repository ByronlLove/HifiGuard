"""
HifiGuard - Daemon Python
Sources : NIOSH 1998 (REL 85 dB, exchange rate 3 dB)
          OMS/ITU H.870 (80 dB / 40h semaine)
          Filtre A-weighting : IEC 61672-1
"""

import sys
import os
from pathlib import Path

import warnings
warnings.simplefilter("ignore")

if getattr(sys, 'frozen', False):
    try:
        app_root = Path(os.environ.get('APPDATA', '')) / "HifiGuard"
        app_root.mkdir(parents=True, exist_ok=True)
        log_file = app_root / "daemon_errors.log"
        
        f_err = open(log_file, 'a', encoding='utf-8', buffering=1)
        # On ne redirige QUE les erreurs critiques (crashes, bugs) vers le fichier texte
        sys.stderr = f_err
    except Exception:
        pass

sys.coinit_flags = 2

if hasattr(sys.stdout, 'reconfigure'):
    try:
        sys.stdout.reconfigure(encoding='utf-8', errors='replace')
    except Exception: pass
if hasattr(sys.stderr, 'reconfigure'):
    try:
        sys.stderr.reconfigure(encoding='utf-8', errors='replace')
    except Exception: pass

import comtypes
import sounddevice as sd
import soundcard as sc
import numpy as np
import json
import csv
import time
from datetime import datetime, timedelta
import scipy.signal as signal
from pycaw.pycaw import AudioUtilities
import threading
SHARED_STATE = {'force_reload': False}

def stdin_listener():
    """Écoute en permanence les ordres instantanés de Node.js"""
    import sys
    while True:
        try:
            line = sys.stdin.readline()
            if not line: break
            if 'RELOAD' in line:
                SHARED_STATE['force_reload'] = True
        except Exception:
            break
# ══════════════════════════════════════════════════════════
# CHEMINS
# ══════════════════════════════════════════════════════════
if getattr(sys, 'frozen', False):
    # Mode PRODUCTION (.exe compilé)
    APPDATA_DIR = os.environ.get('APPDATA')
    DATA_DIR    = os.path.join(APPDATA_DIR, 'HifiGuard', 'data')
else:
    # Mode DÉVELOPPEMENT (script .py lancé par npm start)
    BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    DATA_DIR = os.path.join(BASE_DIR, 'data')

CONFIG_PATH = os.path.join(DATA_DIR, 'config.json')
JSON_PATH   = os.path.join(DATA_DIR, 'suivi_audio.json')
CSV_PATH    = os.path.join(DATA_DIR, 'historique.csv')
STATE_PATH  = os.path.join(DATA_DIR, 'state.json')

os.makedirs(DATA_DIR, exist_ok=True)

# ══════════════════════════════════════════════════════════
# CONFIG PAR DÉFAUT 
# ══════════════════════════════════════════════════════════
DEFAULT_CONFIG = {
    "active_profile": "",
    "profiles": {},
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
                data = json.load(f)
                # Le bouclier : on vérifie que les clés existent bien
                if 'active_profile' in data and 'profiles' in data:
                    return data
        except Exception:
            pass
    
    # Si le fichier n'existe pas ou qu'il est incomplet, on recrée la config par défaut
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
        sens_dbmw = 124 - 20*np.log10(raw) + 10*np.log10(imp)
    elif unit == 'dB/V':
        # dB/V = dB/mW + 10·log10(imp/1000)
        # → dB/mW = dB/V - 10·log10(imp/1000)
        sens_dbmw = raw - 10*np.log10(1000/imp)
    else:
        sens_dbmw = raw

    p_max   = ((vout**2) / imp) * 1000   # mW
    max_spl = sens_dbmw + 10*np.log10(p_max)
    return max_spl, sens_dbmw

def get_active_profile(config):
    # On utilise .get() pour ne pas crasher si la clé n'existe pas
    name = config.get('active_profile', "")
    profiles = config.get('profiles', {})
    
    # Si aucun profil n'est sélectionné ou qu'il n'existe pas dans la liste
    if not name or name not in profiles:
        # On renvoie des valeurs nulles/vides sécurisées (Mode Attente)
        return "", {}, 0.0, 0.0
        
    # Si tout va bien, on charge le profil normalement
    profile = profiles[name]
    max_spl, sens_dbmw = compute_max_spl(profile)
    return name, profile, max_spl, sens_dbmw

# ══════════════════════════════════════════════════════════
# NORMES
# ══════════════════════════════════════════════════════════
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
# NOUVEAU : GÉNÉRATEUR DE FILTRE AUTOEQ (FIR)
# ══════════════════════════════════════════════════════════
def build_autoeq_filter(filepath, fs, numtaps=1025):
    """
    Lit un fichier GraphicEQ (.txt) et génère un filtre FIR interpolé.
    numtaps = 1025 (Impair = Type I) permet d'avoir un gain précis même à Nyquist.
    """
    try:
        with open(filepath, 'r', encoding='utf-8') as f:
            content = f.read()

        if not content.startswith('GraphicEQ:'):
            return None

        points_str = content.replace('GraphicEQ:', '').strip().split(';')
        freqs, gains = [], []
        
        for p in points_str:
            parts = p.strip().split()
            if len(parts) == 2:
                freqs.append(float(parts[0]))
                gains.append(float(parts[1]))

        if not freqs:
            return None

        # Nettoyage et tri strict des fréquences
        fg = sorted(list(set(zip(freqs, gains))), key=lambda x: x[0])
        freqs = [x[0] for x in fg]
        gains = [x[1] for x in fg]
        # --- LOGIQUE ACOUSTIQUE : INVERSION & NORMALISATION ---
        # 1. On trouve l'indice de la fréquence la plus proche de 1000 Hz
        idx_1k = min(range(len(freqs)), key=lambda i: abs(freqs[i] - 1000.0))
        gain_1k = gains[idx_1k]

        # 2. On inverse la courbe ET on la recale pour que 1000 Hz = 0 dB
        # Formule : Gain_Acoustique = Gain_AutoEq(1000Hz) - Gain_AutoEq(f)
        gains = [gain_1k - g for g in gains]
        # ------------------------------------------------------

        nyq = fs / 2.0

        # On s'assure que la courbe commence bien à 0 Hz
        if freqs[0] > 0:
            freqs.insert(0, 0.0)
            gains.insert(0, gains[0])

        # On s'assure que la courbe va jusqu'à la limite du DAC (Nyquist)
        if freqs[-1] < nyq:
            freqs.append(nyq)
            gains.append(gains[-1])

        freqs_norm = []
        amps = []
        
        for f, g in zip(freqs, gains):
            fn = min(1.0, f / nyq)
            # scipy.firwin2 exige des fréquences strictement croissantes
            if not freqs_norm or fn > freqs_norm[-1]:
                freqs_norm.append(fn)
                # Conversion du Gain (dB) en multiplicateur d'Amplitude linéaire
                amps.append(10 ** (g / 20.0))

        # Borner la fin exactement à 1.0
        if freqs_norm[-1] < 1.0:
            freqs_norm.append(1.0)
            amps.append(amps[-1])
        else:
            freqs_norm[-1] = 1.0

        # Génération de la courbe interpolée via firwin2
        taps = signal.firwin2(numtaps, freqs_norm, amps)
        return taps
    except Exception as e:
        print(f"\n[AutoEq] Erreur lors de la création du filtre: {e}")
        return None

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
        
        # 1. On calcule la dose à chaque micro-frame (précision maximale)
        if db_a >= 70:
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
                    '_sum_a':     0.0, '_count_a': 0,
                    '_sum_z':     0.0, '_count_z': 0,
                    '_buckets_a': {},
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

            # Moyenne et médiane dB(A)/dB(Z)
            if '_sum_a' not in d:
                d['_sum_a'] = 0.0; d['_count_a'] = 0
                d['_sum_z'] = 0.0; d['_count_z'] = 0
                d['_buckets_a'] = {}
            d['_sum_a']  += db_a; d['_count_a'] += 1
            d['_sum_z']  += db_z; d['_count_z'] += 1
            bk = str(round(db_a * 2) / 2)  
            d['_buckets_a'][bk] = d['_buckets_a'].get(bk, 0) + 1
            d['mean_db_a']   = round(d['_sum_a'] / d['_count_a'], 1)
            d['mean_db_z']   = round(d['_sum_z'] / d['_count_z'], 1)

            total_pts = sum(d['_buckets_a'].values())
            half_pts  = total_pts / 2
            cum       = 0
            for bv in sorted(d['_buckets_a'].keys(), key=float):
                cum += d['_buckets_a'][bv]
                if cum >= half_pts:
                    d['median_db_a'] = float(bv)
                    break

        # 2. SAUVEGARDE ANTI-AMNÉSIE (Toutes les 1 seconde au lieu de 30)
        # Quoi qu'il arrive, la dose est blindée sur le disque dur.
        if time.time() - self._csv_buf_ts >= 1.0:
            self._flush_csv(profile_name)
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
# STATE.JSON - écriture sans plantage sur Windows
# ══════════════════════════════════════════════════════════
def write_state(db_a, db_z, vol_db, stats, week_who, profile_name, refresh_cfg, db_a_raw=None, spectrum=None):
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
    # On ajoute la valeur brute sans correction si on est en mode comparaison
    if db_a_raw is not None:
        state['db_a_raw'] = round(db_a_raw, 1)
    if spectrum is not None:
        state['spectrum'] = spectrum

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
# Codes d'erreur Windows Media Foundation qui indiquent une perte de device audio
# on tente un reconnect au lieu de mourir
_WMF_RECOVERABLE = {
    'Error 0x88890004',   # AUDCLNT_E_DEVICE_INVALIDATED
    'Error 0x8889000a',   # AUDCLNT_E_RESOURCES_INVALIDATED
    'Error 0x100000001',  # Erreur de cleanup __exit__ après crash
}
MAX_RETRIES    = 10       # tentatives max avant abandon
RETRY_DELAY_S  = 2.0     # secondes entre chaque tentative

def _run_capture(tracker, config, profile_name, MAX_SPL, refresh_cfg):
    """
    Boucle de capture audio optimisée avec "Hot Reload" des paramètres matériels.
    """
    python_ms = refresh_cfg['python_ms']

    # --- DÉTECTION DYNAMIQUE DES HZ DU DAC ---
    try:
        wasapi_id = next(i for i, api in enumerate(sd.query_hostapis()) if 'WASAPI' in api['name'])
        wasapi_info = sd.query_hostapis(wasapi_id)
        device_info = sd.query_devices(wasapi_info['default_output_device'])
        DAC_FS = int(device_info['default_samplerate'])
        
        # --- NOUVEAU : LECTURE DU BUFFER WINDOWS ---
        hw_latency_ms = device_info.get('default_low_output_latency', 0.0) * 1000
        print(f"\n[Système] Buffer matériel Windows détecté : ~{hw_latency_ms:.1f} ms")
        print(f"[Python] Demande de paquets audio bloquants : 10.0 ms\n")
        
    except Exception as e:
        print(f'[DAC] Détection échouée ({e}), fallback à 44100 Hz')
        DAC_FS = 44100
    # ------------------------------------------

    BLOCK_SIZE        = int(DAC_FS * 10 / 1000)
    seconds_per_block = BLOCK_SIZE / DAC_FS
    save_every        = max(1, int(30000 / python_ms))

    # Filtre A-Weighting de base
    b, a = build_a_weighting_filter(DAC_FS)
    zi     = signal.lfilter_zi(b, a)
    zi_raw = signal.lfilter_zi(b, a)  # Utilisé uniquement en mode comparaison CPU+

    devices = AudioUtilities.GetSpeakers()
    volume  = devices.EndpointVolume

    # --- NOUVEAU : Écoute du DAC spécifique sélectionné ---
    device_name = config.get('audio_device', 'default')
    try:
        if device_name and device_name != 'default':
            speaker = sc.get_speaker(id=device_name)
        else:
            speaker = sc.default_speaker()
    except Exception as e:
        print(f"Erreur périphérique {device_name}, retour au défaut. ({e})")
        speaker = sc.default_speaker()

    # --- NOUVEAU : On force Python à prendre le "Loopback" et à ignorer l'entrée Micro ---
    all_mics = sc.all_microphones(include_loopback=True)
    mic = None
    
    # On cherche le périphérique qui a le bon nom ET qui est un flux interne (Loopback)
    for m in all_mics:
        if getattr(m, 'isloopback', False) and m.name == speaker.name:
            mic = m
            break
            
    # Sécurité de secours
    if not mic:
        mic = sc.get_microphone(id=speaker.name, include_loopback=True)

    print(f'Monitoring : {mic.name} (Loopback) (@ {DAC_FS} Hz)')
    current_profiles = config.get('profiles', {})
    profile = current_profiles.get(profile_name, {})

    # Variables pour stocker le filtre EQ en mémoire
    fft_window_size = 8192
    fft_buffer = np.zeros(fft_window_size)

    # Surveillance des changements de périphérique
    _consecutive_silence = 0
    _silence_device_check = int(5.0 / seconds_per_block)  # Vérifie toutes les 5s de silence
    try:
        _last_known_default = sc.default_speaker().name
    except Exception:
        _last_known_default = ""
    
    current_autoeq_file = None
    taps = None
    zi_eq = None

    # --- MOTEUR À DOUBLE VITESSE ---
    # 1. Vitesse Matérielle (Verrouillée à 10ms pour le WebGL)
    BLOCK_MS = 10
    BLOCK_SIZE = int(DAC_FS * BLOCK_MS / 1000)
    seconds_per_block = BLOCK_SIZE / DAC_FS

    # 2. Vitesse de l'Interface (Dictée par les réglages de l'app, ex: 250ms ou 1000ms)
    ui_report_ms = max(refresh_cfg['python_ms'], 10) 
    blocks_per_report = int(ui_report_ms / BLOCK_MS)
    if blocks_per_report < 1: 
        blocks_per_report = 1

    block_counter = 0
    config_check_counter = 0

    import warnings
    threading.Thread(target=stdin_listener, daemon=True).start()
    with mic.recorder(samplerate=DAC_FS, blocksize=BLOCK_SIZE) as recorder:
        with warnings.catch_warnings():
            warnings.simplefilter("ignore")
            while True:
                config_check_counter += 1

                # ── MODE ATTENTE (Si aucun profil n'est configuré) ─────────
                if not profile_name:
                    time.sleep(1.0)
                    stats = tracker.today_stats()
                    write_state(0.0, 0.0, 0.0, stats, tracker.weekly_who_dose(), "En attente de configuration...", refresh_cfg)
                    try:
                        new_cfg = load_config()
                        if new_cfg.get('active_profile') and new_cfg.get('active_profile') in new_cfg.get('profiles', {}):
                            return 'config_changed'
                    except Exception: pass
                    continue

                # ── VÉRIFICATION DE LA CONFIG (Instantanée ou toutes les 5s) ─────
                if SHARED_STATE['force_reload'] or config_check_counter >= 500:
                    SHARED_STATE['force_reload'] = False
                    config_check_counter = 0
                    try:
                        new_cfg = load_config()
                        new_profile_name = new_cfg.get('active_profile')
                        new_cfg = load_config()
                        new_profile_name = new_cfg.get('active_profile')
                        
                        # 1. Si le matériel audio change, on est obligé de redémarrer le flux
                        if new_cfg.get('refresh_mode') != config.get('refresh_mode') or \
                           new_profile_name != profile_name or \
                           new_cfg.get('compare_eq', False) != config.get('compare_eq', False):
                            return 'config_changed'
                            
                        # 2. LA MAGIE DU HOT-RELOAD :
                        # On met à jour la mémoire de Python en direct. 
                        # Si l'UI a activé le Spectre, Python va l'allumer sans s'arrêter !
                        config = new_cfg  
                        
                        if new_profile_name:
                            new_profile_data = new_cfg.get('profiles', {}).get(new_profile_name)
                            if new_profile_data != profile:
                                profile = new_profile_data
                                MAX_SPL, sens_dbmw = compute_max_spl(profile)
                    except Exception:
                        pass

                # ── VÉRIFICATION ET CHARGEMENT DU FILTRE AUTOEQ ──
                has_eq = bool(profile.get('autoeq_file'))
                compare_mode = config.get('compare_eq', False)

                if has_eq and profile['autoeq_file'] != current_autoeq_file:
                    current_autoeq_file = profile['autoeq_file']
                    eq_path = os.path.join(DATA_DIR, current_autoeq_file)
                    if os.path.exists(eq_path):
                        taps = build_autoeq_filter(eq_path, DAC_FS)
                        if taps is not None:
                            zi_eq = signal.lfilter_zi(taps, [1.0])
                            print(f'\n[AutoEq] Filtre FIR chargé avec succès : {current_autoeq_file}')
                        else:
                            print(f'\n[AutoEq] Fichier invalide ou mal formaté : {current_autoeq_file}')
                    else:
                        print(f'\n[AutoEq] Fichier introuvable : {current_autoeq_file}')
                        taps = None
                elif not has_eq and current_autoeq_file is not None:
                    current_autoeq_file = None
                    taps = None
                    zi_eq = None

                # ── CAPTURE ET CALCULS ─────────────────────────────────────
                vol_db   = volume.GetMasterVolumeLevel()
                is_muted = (vol_db < -60)

                data = recorder.record(numframes=BLOCK_SIZE)
                if len(data.shape) > 1:
                    data = np.mean(data, axis=1)

                rms_raw = np.sqrt(np.mean(data**2))

                # 1. Gestion du silence
                if rms_raw < SILENCE_THRESHOLD or is_muted:
                    _consecutive_silence += 1

                    # Toutes les 5s de silence, on vérifie si Windows a changé de périph
                    if _consecutive_silence >= _silence_device_check:
                        _consecutive_silence = 0
                        try:
                            current_default = sc.default_speaker().name
                            if current_default != _last_known_default:
                                print(f'\n[Audio] Périphérique changé détecté : {current_default} — reconnexion...')
                                return 'config_changed'
                        except Exception:
                            pass

                    if time.time() - tracker._csv_buf_ts >= 1.0:
                        tracker._flush_csv(profile_name)
                    
                    # --- CORRECTION 1 : DESSINER LA GRILLE MÊME DANS LE SILENCE ---
                    if config.get('spectrum_enabled', False):
                        empty_bands = int(config.get('spectrum_bands', 80))
                        sys.stdout.write('\nSPEC|' + json.dumps([0.0] * empty_bands) + '\n')
                        sys.stdout.flush()
                    # -------------------------------------------------------------

                    # On respecte le rythme de l'UI pour écrire l'état (sans bloquer)
                    block_counter += 1
                    if block_counter >= blocks_per_report:
                        stats    = tracker.today_stats()
                        week_who = tracker.weekly_who_dose()
                        write_state(0.0, 0.0, vol_db, stats, week_who, profile_name, refresh_cfg)
                        block_counter = 0
                        
                    continue

                # Réinitialise le compteur dès qu'il y a du son
                _consecutive_silence = 0

                # 2. Calcul dB(Z) Brut Physique
                db_z = max(0.0, min(MAX_SPL + 20*np.log10(rms_raw + 1e-12) + vol_db, CEILING_DB))
                db_a_raw = None

                # 3. Application du Filtre AutoEQ (si présent)
                if taps is not None:
                    data_eq, zi_eq = signal.lfilter(taps, [1.0], data, zi=zi_eq)
                else:
                    data_eq = data

                # 4. Mode Comparaison CPU+ (Avant le filtre A)
                if compare_mode:
                    if taps is not None:
                        data_a_raw_buf, zi_raw = signal.lfilter(b, a, data, zi=zi_raw)
                        rms_a_raw = np.sqrt(np.mean(data_a_raw_buf**2))
                        db_a_raw = max(0.0, min(MAX_SPL + 20*np.log10(rms_a_raw + 1e-12) + vol_db, CEILING_DB))
                    else:
                        db_a_raw = None

                # 5. Calcul dB(A) FINAL (Sur la musique égalisée)
                data_a, zi = signal.lfilter(b, a, data_eq, zi=zi)
                rms_a = np.sqrt(np.mean(data_a**2))
                db_a  = max(0.0, min(MAX_SPL + 20*np.log10(rms_a + 1e-12) + vol_db, CEILING_DB))

                if compare_mode and taps is None:
                    db_a_raw = db_a

                # 6. ANALYSEUR DE SPECTRE
                current_spectrum = None
                spectrum_enabled = config.get('spectrum_enabled', False)

                if spectrum_enabled:
                    n_data = len(data_eq)
                    n_buf = len(fft_buffer)
                    if n_data >= n_buf:
                        fft_buffer[:] = data_eq[-n_buf:]
                    else:
                        fft_buffer = np.roll(fft_buffer, -n_data)
                        fft_buffer[-n_data:] = data_eq

                    FB_FREQS = [
                        50, 54, 59, 63, 74, 80, 87, 94, 102, 110, 119, 129, 139, 150, 163, 176, 191, 206, 223, 241,
                        261, 282, 306, 331, 358, 387, 419, 453, 490, 530, 574, 620, 671, 726, 786, 850, 920, 1000,
                        1100, 1200, 1300, 1400, 1500, 1600, 1700, 1800, 1900, 2000, 2200, 2400, 2600, 2800, 3000,
                        3200, 3500, 3800, 4100, 4400, 4800, 5200, 5600, 6100, 6600, 7100, 7700, 8300, 9000, 10000,
                        11000, 12000, 13000, 14000, 16000, 17000, 18000, 20000, 21000, 23000, 25000
                    ]

                    spectrum_bands = int(config.get('spectrum_bands', 80))

                    if spectrum_bands <= 80:
                        step = max(1, len(FB_FREQS) // max(1, spectrum_bands))
                        log_bounds = [FB_FREQS[i] for i in range(0, len(FB_FREQS), step)]
                        if len(log_bounds) < spectrum_bands + 1:
                            log_bounds.append(FB_FREQS[-1])
                    else:
                        x_old = np.linspace(0, 1, len(FB_FREQS))
                        x_new = np.linspace(0, 1, spectrum_bands + 1)
                        log_bounds = 10 ** np.interp(x_new, x_old, np.log10(FB_FREQS))

                    window_h = np.hanning(len(fft_buffer))
                    window_norm = np.sum(window_h)  # Compensation amplitude fenêtre de Hann
                    fft_res = np.abs(np.fft.rfft(fft_buffer * window_h))
                    freqs = np.fft.rfftfreq(len(fft_buffer), 1.0 / DAC_FS)
                    # Le facteur 2.0 compense le spectre unilatéral (rfft = moitié du spectre)
                    fft_db = 20 * np.log10(2.0 * fft_res / window_norm + 1e-12) + MAX_SPL + vol_db

                    weight_mode = config.get('spectrum_weight', 'Z')
                    if weight_mode == 'A':
                        freqs_safe = np.maximum(freqs, 1e-6)
                        f2 = freqs_safe**2
                        c1, c2, c3, c4 = 12194.217**2, 20.598997**2, 107.65265**2, 737.86223**2
                        Ra = (c1 * f2**2) / ((f2 + c2) * np.sqrt((f2 + c3) * (f2 + c4)) * (f2 + c1))
                        fft_db = fft_db + (20 * np.log10(Ra + 1e-12) + 2.0)

                    indices = np.searchsorted(freqs, log_bounds)
                    band_dbs = []

                    for i in range(len(log_bounds) - 1):
                        i1, i2 = indices[i], indices[i+1]
                        if i1 < i2:
                            val = np.max(fft_db[i1:i2])
                        else:
                            center_f = np.sqrt(log_bounds[i] * log_bounds[i+1])
                            exact_idx = center_f * (len(fft_buffer) / DAC_FS)
                            idx1_int, idx2_int = int(np.floor(exact_idx)), int(np.ceil(exact_idx))
                            if idx2_int < len(fft_db):
                                frac = exact_idx - idx1_int
                                val = fft_db[idx1_int] * (1-frac) + fft_db[idx2_int] * frac
                            else:
                                val = fft_db[-1]
                        band_dbs.append(max(0.0, float(val)))

                    current_spectrum = band_dbs


                # ── ACTION 1 : ENVOI IMMÉDIAT DU SPECTRE DANS LA RAM (TOUTES LES 10 MS) ──
                if current_spectrum:
                    sys.stdout.write('\nSPEC|' + json.dumps(current_spectrum) + '\n')
                    sys.stdout.flush()


                # ── ACTION 2 : ENREGISTREMENT CONTINU DE LA DOSE (TOUTES LES 10 MS) ──
                tracker.record(db_z, db_a, vol_db, profile_name, seconds_per_block, save_every)


                # ── ACTION 3 : LE RAPPORT UI SÉCURISÉ (SELON LES RÉGLAGES) ──
                block_counter += 1
                if block_counter >= blocks_per_report:
                    stats    = tracker.today_stats()
                    week_who = tracker.weekly_who_dose()

                    # On met à jour state.json pour l'UI, SANS lui injecter le spectre (qui passerait par le disque dur)
                    write_state(db_a, db_z, vol_db, stats, week_who, profile_name, refresh_cfg, db_a_raw, None)

                    # Affichage console (Daemon)
                    info = (
                        f'\r\033[K{risk_label(db_a)}{bar(db_a)} '
                        f'Z:{db_z:5.1f} A:{db_a:5.1f} dB(A) | '
                        f'N:{stats["dose_niosh_pct"]:5.1f}% | '
                        f'O/j:{stats["dose_who_day_pct"]:5.1f}% | '
                        f'O/7j:{week_who:5.1f}% | '
                        f'Max:{stats["max_db_a"]:.1f}'
                    )
                    sys.stdout.write(info)
                    sys.stdout.flush()

                    # On remet le compteur à zéro pour attendre le prochain cycle UI
                    block_counter = 0
def main():
    if '--list-devices' in sys.argv:
        try:
            import soundcard as sc
            import json
            spks = sc.all_speakers()
            res = [{'id': s.name, 'name': s.name} for s in spks]
            print(json.dumps(res))
        except Exception:
            print("[]")
        return

    config = load_config()
    profile_name, profile, MAX_SPL, sens_dbmw = get_active_profile(config)
    refresh_cfg = get_refresh_settings(config)

    print('=' * 42)
    print('  HifiGuard - Daemon (NIOSH/OMS)')
    print('=' * 42)
    print(f'  Profil  : {profile_name}')
    print(f'  MAX_SPL : {MAX_SPL:.1f} dB')
    print(f'  Sensi   : {sens_dbmw:.1f} dB/mW (unit: {profile.get("sensitivity_unit","dB/mW")})')
    print(f'  Mode    : {config.get("refresh_mode","focus")} ({refresh_cfg["python_ms"]}ms)')
    print(f'  Data    : {DATA_DIR}')
    print('=' * 42)
    print()

    tracker = AudioTracker()
    tracker._csv_init()

    retries = 0

    while retries < MAX_RETRIES:
        try:
            result = _run_capture(tracker, config, profile_name, MAX_SPL, refresh_cfg)

            if result == 'config_changed':
                # Rechargement propre de la config sans incrémenter les retries
                print('\n[Config] Rechargement...')
                config = load_config()
                profile_name, profile, MAX_SPL, sens_dbmw = get_active_profile(config)
                refresh_cfg = get_refresh_settings(config)
                retries = 0
                continue

            # Sortie normale (ne devrait pas arriver sans exception)
            break

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
            return

        except Exception as e:
            err_str = str(e)
            is_recoverable = any(code in err_str for code in _WMF_RECOVERABLE)

            if is_recoverable:
                retries += 1
                wait = min(RETRY_DELAY_S * retries, 10.0)  # backoff max 10s
                print(f'\n[Audio] Device perdu ({err_str}) — reconnexion dans {wait:.0f}s '
                      f'(tentative {retries}/{MAX_RETRIES})')
                tracker.save_json()
                time.sleep(wait)
            else:
                print(f'\nErreur fatale : {e}')
                import traceback
                traceback.print_exc()
                break

    if retries >= MAX_RETRIES:
        print(f'\n[Audio] Echec après {MAX_RETRIES} tentatives. Arrêt.')

if __name__ == '__main__':
    main()
