# 🎧 HifiGuard

**Dosimètre auditif personnel pour casques et écouteurs — Windows**

> ⚠️ **HifiGuard est un outil d'estimation, pas un sonomètre certifié.** Les mesures sont des approximations hautes basées sur le signal numérique Windows et les caractéristiques électriques de votre casque. Voir la section [Limites et précision](#limites-et-précision).

![Interface HifiGuard](assets/screenshot-today.png)

---

## 📋 Sommaire

- [Fonctionnalités](#fonctionnalités)
- [Installation](#installation)
- [Configuration du profil casque](#configuration-du-profil-casque)
- [Comment ça marche](#comment-ça-marche)
- [Normes de référence](#normes-de-référence)
- [Limites et précision](#limites-et-précision)
- [Modes de rafraîchissement](#modes-de-rafraîchissement)
- [Développement](#développement)

---

## ✨ Fonctionnalités

- **Mesure en temps réel** du niveau d'exposition sonore en dB(A) et dB(Z)
- **Suivi des doses** NIOSH et OMS/ITU H.870, jour et semaine
- **Graphique aujourd'hui** — courbe live avec résolution ajustable (Auto / 10s / 1min / 5min)
- **Double-clic** sur le graphe → dernière minute en haute précision (mesures toutes les 25ms)
- **Follow mode** — zoom + position extrême droite : la courbe avance en direct
- **Calendrier historique** — vue année → mois → jour avec courbes, stats, moyenne et médiane
- **Moyenne et médiane** calculées uniquement sur les mesures avec son (silences exclus)
- **Icône tray colorée** selon le niveau (vert / jaune / orange / rouge)
- **Compatible Equalizer APO / Peace** — la capture loopback prend en compte l'EQ logiciel
- **Redémarrage automatique** du daemon si le périphérique audio est déconnecté
- **Démarrage avec Windows** au lancement

![Calendrier](assets/screenshot-calendar.png)

---

## 📥 Installation

### Version installateur (recommandé)

Téléchargez `HifiGuard Setup x.x.x.exe` depuis les [Releases](../../releases) et lancez-le.  
Aucune dépendance requise — Python est embarqué.

### Version portable

Téléchargez `HifiGuard-x.x.x-portable.exe` et lancez-le directement.  
Les données sont sauvegardées dans `%APPDATA%\HifiGuard\data\` (ou à côté de l'exe en mode portable).

---

## ⚙️ Configuration du profil casque

HifiGuard a besoin des caractéristiques électriques de votre casque pour calculer le SPL réel reçu à l'oreille. Ces informations se trouvent dans la fiche technique du constructeur ou sur des sites de mesures indépendantes ([Rtings.com](https://www.rtings.com), [Oratory1990](https://www.reddit.com/r/oratory1990/wiki/index/), [Crinacle](https://crinacle.com)).

| Paramètre | Description | Exemple |
|-----------|-------------|---------|
| **Sensibilité** | En dB/mW, mV/Pa ou dB/V selon la fiche produit | `96 dB/mW` |
| **Impédance** | En Ohms (Ω) | `32 Ω` |
| **Tension Vout DAC** | Tension de sortie RMS de votre source (DAC / carte son) | `1.2 Vrms` |

> 💡 La tension Vout de votre DAC ou carte son se trouve dans sa fiche technique. Pour une carte son intégrée standard, comptez environ `1.0–1.5 Vrms`.

### Formule de calcul

```
MAX_SPL = Sensibilité_dBmW + 10 × log10((Vout² / Impédance) × 1000)
SPL_mesuré = MAX_SPL + 20 × log10(RMS_signal) + Volume_Windows_dB
```

![Paramètres](assets/screenshot-settings.png)

---

## 🔬 Comment ça marche

HifiGuard capture le flux audio via le **loopback WASAPI** de Windows — ce que Windows envoie réellement à votre périphérique de sortie par défaut. Chaque mesure passe par deux traitements :

**dB(Z)** — niveau brut sans pondération fréquentielle (pression acoustique pure).

**dB(A)** — pondération A-weighting selon IEC 61672-1, qui modélise la sensibilité de l'oreille humaine (atténuation des graves et des extrêmes aigus). C'est cette valeur qui est utilisée pour les calculs de dose.

Le daemon Python capture des blocs audio toutes les **25ms**, calcule le pic, et écrit dans le CSV **1 ligne par seconde** (pic de la seconde écoulée). L'interface affiche ces données en temps réel via Electron.

### Graphique — haute précision

Un **double-clic** sur le graphe "Aujourd'hui" bascule en mode haute précision : les 2400 derniers points (1 minute à 25ms/point) sont affichés depuis la mémoire vive, mise à jour en continu même quand HifiGuard est réduit dans la barre des tâches. Un second double-clic revient à la vue journée.

---

## 📊 Normes de référence

| Norme | Seuil | Durée maximale | Exchange rate |
|-------|-------|----------------|---------------|
| **NIOSH (1998)** | 85 dB(A) | 8h / jour | 3 dB |
| **OMS/ITU H.870** | 80 dB(A) | ~5h42 / jour | 3 dB |
| **OMS/ITU H.870** | 80 dB(A) | 40h / semaine | 3 dB |

L'exchange rate de 3 dB signifie que chaque augmentation de 3 dB divise par deux la durée d'exposition autorisée. À 88 dB(A) NIOSH, la durée maximale tombe à 4h.

---

## ⚠️ Limites et précision

HifiGuard mesure le signal **numérique** envoyé par Windows à votre casque. Les mesures sont des **approximations hautes** — elles correspondent au niveau maximal théorique que votre casque peut produire, en supposant que votre profil est correctement configuré.

**Cas où les mesures sont correctes :**
- Écoute directe via Windows (lecteur Windows, navigateur, Spotify, etc.)
- EQ logiciel via Equalizer APO / Peace — la capture loopback voit l'EQ appliqué

**Cas où les mesures peuvent être incorrectes ou absentes :**
- **DAC externe avec bouton de volume physique** — HifiGuard ne connaît pas ce gain analogique. Si votre DAC ajoute +6 dB via un bouton physique, les mesures seront sous-estimées de 6 dB.
- **Mode WASAPI Exclusif ou ASIO** — certains lecteurs audiophiles (Audirvana, Foobar2000 en mode exclusif) court-circuitent le mixeur Windows. HifiGuard ne capturera rien ou des valeurs fausses.
- **Casque Bluetooth avec traitement DSP interne** — le niveau numérique envoyé ne reflète pas le traitement audio interne du casque.

> HifiGuard n'est **pas** un sonomètre certifié IEC 61672. Pour une mesure réglementaire, utilisez un sonomètre acoustique homologué.

---

## 🔄 Modes de rafraîchissement

| Mode | Intervalle UI | Intervalle tray | Usage |
|------|--------------|-----------------|-------|
| **Focus** | 250ms | 1s | Utilisation normale |
| **Réduit** | 1s | 1s | Fenêtre en arrière-plan |
| **Éco** | 1s | 2s | Économie de ressources |
| **Personnalisé** | Libre | Libre | Avancé |

**Python (ms)** — intervalle de capture audio. À 25ms, Python capture ~1100 échantillons à 44100 Hz, calcule le pic sur ce bloc, et l'écrit dans `state.json`. L'UI poll ce fichier toutes les `ui_ms`. Le CSV reçoit toujours 1 ligne/seconde (pic de la seconde), indépendamment de l'intervalle Python.

---

## 🛠️ Développement

### Prérequis

- [Node.js](https://nodejs.org) 18+
- [Python](https://www.python.org) 3.10+
- pip : `soundcard numpy scipy pycaw comtypes`

### Lancer en mode développement

```bash
# Installer les dépendances Node
npm install

# Installer les dépendances Python
pip install soundcard numpy scipy pycaw comtypes

# Lancer
npm start
```

### Build (installeur + portable)

```bash
# Windows — double-cliquer sur build.bat
# ou en ligne de commande :

# 1. Compiler le daemon Python
pyinstaller --onefile --noconsole --name hifiguard --distpath daemon/dist daemon/hifiguard.py

# 2. Build Electron
npm run build
```

Les fichiers de sortie sont dans `dist/`.

### Structure du projet

```
HifiGuard/
├── electron/          # Main process Electron
│   ├── main.js
│   └── preload.js
├── ui/                # Interface (HTML/CSS/JS)
│   ├── index.html
│   └── renderer.js
├── daemon/            # Daemon Python
│   └── hifiguard.py
├── data/              # Données générées (ignoré par git)
│   ├── config.json
│   ├── state.json
│   ├── suivi_audio.json
│   └── historique.csv
├── assets/            # Icônes et captures
├── build.bat          # Script de build Windows
└── package.json
```

---

## 📄 Licence

MIT — voir [LICENSE](LICENSE)

---

> **HifiGuard** — Prends soin de tes oreilles. 🎧
