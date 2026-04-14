![](assets/icon%20banner.svg)

**Dosimètre auditif personnel pour casques et écouteurs — Windows**

*Read this in other languages: [Français](README_FR.md).*

HifiGuard est un dosimètre auditif pour Windows, basé sur Electron et Python, conçu pour le suivi de l'exposition sonore lors de l'utilisation de casques ou d'écouteurs. L'application intercepte le flux audio numérique système via le loopback WASAPI et calcule, en fonction des spécifications électriques du matériel, la pression acoustique (SPL) théorique reçue à l'oreille.

Le moteur d'analyse applique une pondération fréquentielle A-weighting (norme IEC 61672-1) pour refléter la sensibilité de l'audition humaine. Il permet de quantifier l'exposition quotidienne et hebdomadaire en se basant sur les référentiels NIOSH et OMS/ITU H.870.

HifiGuard est nativement compatible avec les solutions d'égalisation système telles qu'[Equalizer APO](https://sourceforge.net/projects/equalizerapo/) (ou son interface [Peace GUI](https://sourceforge.net/projects/peace-equalizer-apo-extension/)), dont il intègre les modifications de gain et de filtrage dans ses calculs.


> **Avertissement :** HifiGuard est un outil d'estimation logicielle et non un sonomètre matériel certifié. Les résultats fournis sont des approximations hautes destinées à la prévention et ne sauraient remplacer une mesure acoustique effectuée avec un appareil certifié IEC 61672. Pour une mesure réglementaire, utilisez un sonomètre acoustique homologué.

-----

## Aperçu de l'interface

![Interface principale](assets/screenshots/today.png)

![Calendrier historique](assets/screenshots/calendar.png)

<p align="center">
  <img src="assets/screenshots/settings1.png" width="49%">
  <img src="assets/screenshots/settings2.png" width="49%">
</p>

<p align="center">
  <img src="assets/screenshots/tray.png" alt="Tray">
</p>




## Installation

| Version | Prérequis | Remarques |
|--------------------------------|-----------|-----------|
| `HifiGuard_Setup_v1.0.0.exe` | Windows 10/11 | Installateur standard. Moteur Python embarqué. |
| `HifiGuard-v1.0.0-portable.exe` | Windows 10/11 | Version autonome. Données stockées dans `%APPDATA%\HifiGuard\data\`. |

## Spécifications matérielles (Profils)

Pour que le calcul de la pression acoustique (SPL) soit exact, le moteur nécessite les caractéristiques électriques de votre équipement (casque ou écouteurs intra-auriculaires). Ces paramètres doivent être définis dans l'interface de l'application (onglet Paramètres) ou manuellement via le fichier `config.json`.

| Paramètre        | Description                                                                | Exemple |
|------------------|----------------------------------------------------------------------------|---------|
| **Sensibilité**  | Efficacité du transducteur. Unités acceptées : `dB/mW`, `mV/Pa` ou `dB/V`. | `96`    |
| **Impédance**    | Résistance électrique de la bobine en Ohms (Ω).                            | `32`    |
| **Tension Vout** | Tension de sortie maximale (RMS) du DAC ou de la carte mère.               | `1.2`   |

**Logique de calcul logicielle :**
```text
Puissance_Max (mW) = ((Vout²) / Impédance) * 1000
Plafond_SPL = Sensibilité_dBmW + 10 * log10(Puissance_Max)
SPL_Mesuré = Plafond_SPL + 20 * log10(Signal_RMS) + Volume_Windows_dB






## Limites et précision






HifiGuard mesure le signal **numérique** envoyé par Windows à votre casque. Les mesures sont des **approximations hautes** — elles correspondent au niveau maximal théorique que votre casque peut produire, en supposant que votre profil est correctement configuré.







Le calcul reposant sur l'architecture audio de Windows, certaines configurations matérielles ou logicielles faussent ou bloquent les mesures :

- **Atténuation analogique :** Les DAC ou amplificateurs externes dotés d'un potentiomètre de volume physique modifient le gain après la sortie PC. HifiGuard ne peut pas lire cette réduction matérielle. Pour une mesure correcte, l'amplificateur externe doit être réglé sur un volume fixe (ex: 100%) et l'atténuation doit être gérée via Windows.

- **Bypass du mixeur (ASIO / WASAPI Exclusif) :** Les lecteurs configurés pour prendre le contrôle exclusif du périphérique de sortie (Audirvana, Foobar2000 en mode exclusif) contournent la couche d'écoute de Windows. HifiGuard affichera des résultats erronés.

-  **Casques actifs (DSP interne) :** Les casques Bluetooth ou USB appliquant leur propre profil de correction en interne peuvent avoir un rendement réel différent du calcul électrique théorique. Le signal est traité matériellement à l'intérieur du casque (qui possède son propre DAC, son propre amplificateur et souvent un contrôle de volume indépendant). Le logiciel n'a aucun moyen de lire la tension de cet amplificateur interne ni de mesurer l'impact de son processeur numérique (DSP) sur le son final.






## Développement

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

AGPL-3.0 license — voir [LICENSE](LICENSE)

---

> **HifiGuard** — Prends soin de tes oreilles. 🎧

> HifiGuard n'est **pas** un sonomètre certifié IEC 61672. Pour une mesure réglementaire, utilisez un sonomètre acoustique homologué.
