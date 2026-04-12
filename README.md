# HifiGuard

Dosimètre auditif personnel — NIOSH/OMS

## Structure

```
HifiGuard/
├── electron/
│   ├── main.js        ← Electron (fenêtre + icône système)
│   └── preload.js     ← Bridge IPC
├── ui/
│   ├── index.html     ← Interface
│   └── renderer.js    ← Graphes, calendrier, paramètres
├── daemon/
│   └── hifiguard.py   ← Script Python (mesure audio)
├── data/              ← Créé automatiquement
│   ├── config.json    ← Profils matériels
│   ├── suivi_audio.json
│   ├── historique.csv
│   └── state.json     ← État temps réel
└── package.json
```

## Installation

### 1 — Dépendances Python

```bash
pip install soundcard numpy scipy pycaw comtypes
```

### 2 — Dépendances Node

```bash
npm install
```

### 3 — Lancer en développement

```bash
npm start
```

### 4 — Build Windows (.exe)

```bash
npm run build
```

## Configuration matérielle

Edite `data/config.json` ou utilise l'onglet **Paramètres** dans l'app.

### Conversion sensibilité mV/Pa → dB/mW

Si la fiche technique donne une sensibilité en mV/Pa :

```
dB/mW = 20·log10(mV/Pa / 1000) + 10·log10(1000 / impédance) + 120

Exemple Sennheiser HD599 SE (50 mV/Pa, 50Ω) :
= 20·log10(50/1000) + 10·log10(1000/50) + 120
= -26.02 + 13.01 + 120
= 107 dB/mW
```

## Normes utilisées

| Norme | Seuil | Durée limite | Exchange rate |
|-------|-------|-------------|---------------|
| NIOSH 1998 | 85 dB(A) | 8h/jour | 3 dB |
| OMS/ITU H.870 | 80 dB(A) | 40h/semaine | 3 dB |

## Lancement au démarrage Windows

L'app s'enregistre automatiquement au démarrage via le registre Windows.
Pour désactiver : `Paramètres Windows → Applications → Démarrage → HifiGuard`.
