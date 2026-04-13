# 🎧 HifiGuard

**Dosimètre auditif personnel pour Windows** — surveille le niveau sonore de ton casque en temps réel et calcule ta dose d'exposition selon les normes NIOSH et OMS.

---

<!-- SCREENSHOT: Écran principal "Aujourd'hui" avec le graphe live et les jauges NIOSH/OMS -->
<!-- [Insère ici un screenshot ou GIF de l'écran principal] -->

---

## Sommaire

- [Fonctionnalités](#fonctionnalités)
- [Prérequis](#prérequis)
- [Installation](#installation)
- [Premier lancement](#premier-lancement)
- [Configuration du matériel](#configuration-du-matériel)
- [Interface](#interface)
- [Modes de rafraîchissement](#modes-de-rafraîchissement)
- [Données et export](#données-et-export)
- [Normes utilisées](#normes-utilisées)
- [Architecture](#architecture)
- [FAQ](#faq)

---

## Fonctionnalités

- 📊 **Mesure en temps réel** — dB(A) et dB(Z) toutes les 25ms via le loopback audio Windows
- 🔊 **Filtre A-weighting (IEC 61672-1)** — simule la sensibilité réelle de l'oreille humaine
- 📈 **Graphes interactifs** — zoom molette, pan clic-glisser, double-clic pour zoomer sur les 10 dernières minutes
- ⏸ **Pause graphe** — touche Espace pour figer la courbe sans arrêter la mesure
- 🗓 **Historique calendrier** — navigation Année → Mois → Jour avec animation
- 🎨 **Icône système personnalisable** — couleurs et seuils réglables dans les paramètres
- 👥 **Profils matériels** — plusieurs casques/DAC avec calcul automatique du MAX SPL
- 📤 **Export JSON/CSV** — pour partager ou analyser tes données dans Excel
- 🚀 **Démarrage automatique** — se lance au démarrage de Windows en arrière-plan

<!-- VIDEO: Démo rapide (30s) montrant la navigation calendrier et le graphe live -->
<!-- [Insère ici un GIF ou lien vidéo] -->

---

## Prérequis

| Composant | Version minimum |
|-----------|----------------|
| Windows   | 10 ou 11       |
| Python    | 3.10+          |
| Node.js   | 18+            |
| npm       | 9+             |

---

## Installation

### 1 — Cloner ou télécharger le projet

```bash
git clone https://github.com/ton-repo/hifiguard.git
cd hifiguard
```

Ou télécharge le ZIP et extrais-le.

### 2 — Installer les dépendances Python

Ouvre un terminal dans le dossier `HifiGuard` :

```bash
pip install soundcard numpy scipy pycaw comtypes
```

> ⚠️ Si tu as plusieurs versions de Python, utilise `py -3.10 -m pip install ...` ou remplace `pip` par `pip3`.

### 3 — Installer les dépendances Node.js

```bash
npm install
```

Cela installe Electron et Chart.js automatiquement.

### 4 — Vérifier la structure des dossiers

```
HifiGuard/
├── electron/
│   ├── main.js
│   └── preload.js
├── ui/
│   ├── index.html
│   └── renderer.js
├── daemon/
│   └── hifiguard.py
├── data/              ← créé automatiquement au premier lancement
│   ├── config.json
│   ├── suivi_audio.json
│   ├── historique.csv
│   └── state.json
└── package.json
```

---

## Premier lancement

```bash
npm start
```

L'application :
1. Ouvre la fenêtre principale
2. Lance le daemon Python en arrière-plan (invisible)
3. S'enregistre au démarrage de Windows automatiquement
4. Crée le fichier `data/config.json` avec les profils par défaut

<!-- SCREENSHOT: Premier lancement, fenêtre principale avec le profil Artti T10 actif -->
<!-- [Insère ici un screenshot du premier lancement] -->

> **Note** : Si tu vois une erreur Python au démarrage, clique droit sur l'icône dans la barre des tâches → **Relancer le daemon Python**.

---

## Configuration du matériel

Va dans **⚙ Paramètres → Profils matériels**.

<!-- SCREENSHOT: Page Paramètres avec le formulaire de profil matériel -->
<!-- [Insère ici un screenshot de la page paramètres] -->

### Champs à renseigner

| Champ | Description | Exemple |
|-------|-------------|---------|
| Sensibilité | Efficacité du casque à convertir la puissance en son | `96` |
| Unité | `dB/mW`, `mV/Pa`, ou `dB/V` selon la fiche technique | `dB/mW` |
| Impédance | Résistance électrique du casque en Ohms | `16.5` |
| Tension DAC | Tension de sortie max de ton DAC en Vrms | `1.2` |

### Comment trouver ces valeurs

**Sensibilité** — sur la fiche technique de ton casque. Exemples :
- Artti T10 : **96 dB/mW** → choisir `dB/mW`
- Sennheiser HD599 SE : **50 mV/Pa** → choisir `mV/Pa`
- Certains casques Sony : **105 dB/V** → choisir `dB/V`

**Impédance** — toujours en Ohms sur la fiche technique.

**Tension DAC** — dans le datasheet du chip ampli de ton DAC. Si tu ne la trouves pas :
- MAX97220 : `1.2 Vrms` sur 16Ω
- CX31993 seul : `1.0 Vrms` typique
- Autres DACs USB budget : `1.0–1.2 Vrms`

Le **MAX SPL** se calcule automatiquement et s'affiche en temps réel sous le formulaire.

### Conversion mV/Pa → dB/mW (pour référence)

```
dB/mW = 20·log10(mV/Pa / 1000) + 10·log10(1000 / impédance) + 120
```

L'application fait cette conversion automatiquement selon l'unité choisie.

---

## Interface

### Onglet Aujourd'hui

<!-- SCREENSHOT: Onglet Aujourd'hui avec graphe et statistiques -->
<!-- [Insère ici un screenshot de l'onglet Aujourd'hui] -->

- **Graphe session en cours** — dB(A) en bleu, dose NIOSH en orange pointillé, dose OMS/jour en vert pointillé
- **Légende interactive** — clique sur une couleur pour masquer/afficher la courbe correspondante
- **⏵ Espace = Pause** — en bas à droite dans la légende, ou touche Espace : fige le graphe sans arrêter la mesure. Reprendre recharge automatiquement les données manquantes.
- **Zoom** — molette pour zoomer, clic+glisser pour se déplacer
- **Double-clic** — zoom automatique sur les 10 dernières minutes

### Onglet Historique (Calendrier)

<!-- SCREENSHOT: Vue calendrier mois avec les jours colorés par niveau d'exposition -->
<!-- [Insère ici un screenshot du calendrier] -->

Navigation :
- Clic sur un **mois** → vue des jours du mois avec couleur selon exposition OMS
- Clic sur un **jour** → courbes détaillées de la journée
- Boutons **←** et **→** pour naviguer
- **Breadcrumb** en haut pour remonter : `2026 › Avril › 12 Avril`

Codes couleurs des jours :
- 🟢 Vert — exposition < 20% limite OMS journalière
- 🟡 Jaune-vert — 20–50%
- 🟠 Orange — 50–80%
- 🔴 Rouge — > 80%
- ⬛ Gris — pas de données

### Icône barre des tâches

<!-- SCREENSHOT: Icône dans la barre des tâches avec tooltip -->
<!-- [Insère ici un screenshot de l'icône système avec le tooltip] -->

L'icône change de couleur en temps réel. Les seuils sont personnalisables dans **Paramètres → Couleurs icône**.

Par défaut :
- ⚫ Gris — daemon inactif ou silence
- 🟢 Vert — < 75 dB(A)
- 🟡 Vert-jaune — 75–80 dB(A)
- 🟠 Orange — 80–85 dB(A)
- 🔴 Rouge — > 85 dB(A)

**Clic gauche** — ouvre la fenêtre  
**Clic droit** — menu contextuel :

```
● HifiGuard
──────────────
  Ouvrir
──────────────
  🔄 Relancer le daemon Python
──────────────
  📤 Exporter les données
  ⚙️ Paramètres
──────────────
  Quitter
```

---

## Modes de rafraîchissement

<!-- SCREENSHOT: Section "Mode de rafraîchissement" dans les paramètres -->
<!-- [Insère ici un screenshot des 4 modes] -->

| Mode | Python (calcul) | UI | Usage |
|------|----------------|-----|-------|
| **Focus** | 25ms | 250ms si fenêtre active, 1s sinon | Usage normal |
| **Réduit** | 100ms | 1s | Fenêtre en arrière-plan |
| **Éco** | 200ms | 1s | Laptop sur batterie |
| **Personnalisé** | Libre | Libre | Contrôle total |

> Le daemon Python calcule toujours la dose à la fréquence configurée. Le CSV enregistre **1 ligne par seconde** avec la valeur **maximale** (pic) de la seconde, ce qui est optimal pour la protection auditive (les pics sont plus dangereux que les moyennes).

---

## Données et export

### Fichiers générés

| Fichier | Contenu | Format |
|---------|---------|--------|
| `data/suivi_audio.json` | Agrégats journaliers (dose, max, temps) | JSON |
| `data/historique.csv` | Toutes les mesures (1 ligne/seconde) | CSV |
| `data/config.json` | Profils et paramètres | JSON |
| `data/state.json` | État temps réel (lu par Electron) | JSON |

### Format du CSV

```csv
timestamp,db_z,db_a,vol_db,profile
2026-04-12T14:32:01,78.20,72.10,-6.00,Artti T10
2026-04-12T14:32:02,79.10,73.00,-6.00,Artti T10
```

- `db_z` — niveau brut (Z-weighting, sans filtre)
- `db_a` — niveau perçu (A-weighting, filtré selon sensibilité de l'oreille)
- `vol_db` — volume Windows en dB au moment de la mesure

### Exporter

**Clic droit sur l'icône → Exporter les données** ou **Paramètres → Données → ⤓ Exporter**

- **JSON** — exporte `suivi_audio.json` + config
- **CSV** — exporte `historique.csv` complet

Pour importer dans Excel : Données → Depuis un fichier texte/CSV, séparateur virgule.

---

## Normes utilisées

### NIOSH (National Institute for Occupational Safety and Health, 1998)

| Niveau   | Durée max | Cumul     |
|----------|-----------|-----------|
| 85 dB(A) | 8h        | 100% dose |
| 88 dB(A) | 4h        | 100% dose |
| 91 dB(A) | 2h        | 100% dose |
| 94 dB(A) | 1h        | 100% dose |

Formule : `T(L) = 480 / 2^((L - 85) / 3)` minutes  
Exchange rate : **3 dB** (doublement de l'énergie = réduction de moitié du temps permis)

### OMS/ITU H.870 (2019)

Limite : **80 dB(A) pendant 40 heures par semaine**

La dose OMS journalière (`O/j`) utilise la base 40h/7 ≈ 342 min/jour.  
La dose OMS hebdomadaire (`O/7j`) cumule les 7 derniers jours glissants.

> **Seuil critique** — Au-dessus de 85 dB(A), le risque de perte auditive permanente augmente significativement avec chaque heure d'exposition.

---

## Architecture

```
┌─────────────────────────────────────────────┐
│  Electron (main.js)                         │
│  • Fenêtre frameless + titlebar custom      │
│  • Icône tray dynamique                     │
│  • Lance le daemon Python en arrière-plan   │
│  • Polling state.json toutes les ~250ms     │
└──────────────┬──────────────────────────────┘
               │ IPC (preload.js)
┌──────────────▼──────────────────────────────┐
│  Interface (index.html + renderer.js)       │
│  • Chart.js avec zoom/pan                   │
│  • Navigation calendrier animée             │
│  • Paramètres profils + seuils              │
└─────────────────────────────────────────────┘

┌─────────────────────────────────────────────┐
│  Daemon Python (hifiguard.py)               │
│  • Loopback audio Windows (soundcard)       │
│  • Filtre A-weighting IEC 61672-1           │
│  • Calcul dose NIOSH + OMS toutes les 25ms  │
│  • Écrit state.json (temps réel)            │
│  • Écrit historique.csv (1 pic/seconde)     │
│  • Écrit suivi_audio.json (agrégats)        │
└─────────────────────────────────────────────┘

data/
├── config.json         ← profils matériels, modes, seuils
├── state.json          ← état temps réel (Electron lit ça)
├── suivi_audio.json    ← résumés journaliers
└── historique.csv      ← toutes les mesures
```

---

## FAQ

**Le terminal Python reste visible au démarrage**  
→ Normal en développement (`npm start`). Une fois buildé en `.exe` avec `npm run build`, plus de terminal.

**L'icône ne change pas de couleur**  
→ L'icône ne se recrée que quand le niveau change de zone (vert/orange/rouge). Si le daemon Python est arrêté, elle reste grise. Clic droit → Relancer le daemon.

**Les dB semblent trop élevés ou trop bas**  
→ Vérifie ton profil matériel dans les Paramètres. La valeur `MAX SPL` calculée doit correspondre au niveau maximum théorique de ton casque à plein volume.

**Trou dans le graphe après avoir minimisé la fenêtre**  
→ Normal — le graphe se recharge automatiquement depuis le CSV quand tu remets la fenêtre au premier plan. Les données ne sont pas perdues.

**Comment ajouter un nouveau casque**  
→ Paramètres → Ajouter un profil. Renseigne les specs de la fiche technique. Le MAX SPL se calcule tout seul.

**Comment désactiver le démarrage automatique**  
→ Paramètres Windows → Applications → Démarrage → désactive HifiGuard. Ou : `regedit → HKCU\Software\Microsoft\Windows\CurrentVersion\Run → supprime HifiGuard`.

**Le daemon Python plante**  
→ Clic droit sur l'icône → Relancer le daemon Python. Si ça replante, ouvre un terminal et lance manuellement `python daemon/hifiguard.py` pour voir l'erreur.

---

<!-- NOTES POUR SCREENSHOTS/VIDÉOS :

Captures recommandées :
1. [SCREENSHOT] Écran principal Aujourd'hui — graphe avec une session active, jauges colorées
2. [SCREENSHOT] Calendrier mois — jours colorés avec différents niveaux d'exposition  
3. [SCREENSHOT] Calendrier jour — courbes détaillées dB(A) et dB(Z)
4. [SCREENSHOT] Paramètres — formulaire profil avec le MAX SPL calculé en bas
5. [SCREENSHOT] Icône barre des tâches — zoom sur l'icône colorée avec le tooltip
6. [SCREENSHOT] Menu clic droit — le menu contextuel de l'icône
7. [GIF/VIDEO] Navigation calendrier — zoom animé Année → Mois → Jour
8. [GIF/VIDEO] Zoom graphe — démonstration molette + double-clic 10 dernières minutes
9. [GIF/VIDEO] Pause graphe — touche Espace, la courbe se fige, reprise avec reload

Pour enregistrer les GIFs : utilise ScreenToGif (gratuit) ou ShareX.
Résolution recommandée : 1280×720 minimum.
-->

---

*HifiGuard — Protège tes oreilles, une seconde à la fois.*
