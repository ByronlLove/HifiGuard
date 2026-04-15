![](assets/icon%20banner.svg)

**Dosimètre auditif personnel pour casques et écouteurs — Windows**

*Read this in other languages: [English](README.md).*

HifiGuard est un dosimètre auditif pour Windows, basé sur Electron et Python, conçu pour le suivi de l'exposition sonore lors de l'utilisation de casques ou d'écouteurs. L'application intercepte le flux audio numérique système via le loopback WASAPI et calcule, en fonction des spécifications électriques du matériel, la pression acoustique (SPL) théorique reçue à l'oreille.

Le moteur d'analyse applique une pondération fréquentielle A-weighting (norme IEC 61672-1) pour refléter la sensibilité de l'audition humaine. Il permet de quantifier l'exposition quotidienne et hebdomadaire en se basant sur les référentiels NIOSH et OMS/ITU H.870.

HifiGuard est nativement compatible avec des equalizers systèmes telles qu'[Equalizer APO](https://sourceforge.net/projects/equalizerapo/) et son interface [Peace GUI](https://sourceforge.net/projects/peace-equalizer-apo-extension/), dont il intègre les modifications de gain et de filtrage dans ses calculs.

> **Avertissement :** HifiGuard est un outil d'estimation logicielle et non un sonomètre matériel certifié. Les résultats fournis sont des approximations hautes destinées à la prévention personnelle et ne sauraient remplacer une mesure acoustique effectuée avec un appareil certifié IEC 61672. Pour une mesure réglementaire, utilisez un sonomètre acoustique homologué.

-----

## Aperçu de l'interface

![Interface principale](assets/screenshots/today.png)

![Calendrier historique](assets/screenshots/calendar.png)

<p align="center">
  <img src="assets/screenshots/settings1.png" width="49%">
  <img src="assets/screenshots/settings2.png" width="49%">
</p>

<p align="center">
  <img src="assets/screenshots/tray.png" alt="Barre des tâches">
</p>


## Fonctionnalités

- Mesure en temps réel du niveau d'exposition sonore en dB(A) et dB(Z)
- Suivi des doses NIOSH et OMS/ITU H.870, quotidien et hebdomadaire
- Graphique du jour avec résolution ajustable (Auto / 10s / 1 min / 5 min)
- Double-clic sur le graphe : dernière minute en haute précision (mesures toutes les 25 ms), mise à jour en continu en arrière-plan même réduit dans la barre des tâches
- Follow mode : lorsque zoomé et ancré au bord droit, la courbe avance en temps réel
- Calendrier historique : vue année → mois → jour avec courbes, statistiques, moyenne et médiane
- Métrique secondaire configurable dans la vue mois (OMS %, NIOSH %, moyenne dB(A), médiane dB(A), pic dB(A), moyenne dB(Z))
- Moyenne et médiane calculées uniquement sur les mesures avec son (silences exclus)
- Clic droit sur un jour ou un mois dans le calendrier pour supprimer ses données
- Icône tray colorée selon le niveau (vert / jaune / orange / rouge)
- Compatible Equalizer APO / Peace — la capture loopback prend en compte l'EQ logiciel appliqué
- Redémarrage automatique du daemon en cas de déconnexion du périphérique audio (jusqu'à 10 tentatives)
- Lancement au démarrage de Windows
- Interface en français et en anglais


## Installation

| Version | Fichier | Prérequis |
|---------|---------|-----------|
| Installateur | `HifiGuard Setup x.x.x.exe` | Aucun — Python est intégré |
| Portable | `HifiGuard-x.x.x-portable.exe` | Aucun — Python est intégré |

Téléchargez la dernière version depuis la page [Releases](../../releases).


### Premier lancement

1. Exécutez l'installateur ou le fichier portable.
2. Au premier lancement, choisissez votre langue.
3. Rendez-vous dans **Paramètres** et créez un profil matériel pour votre casque (voir ci-dessous).
4. Le daemon démarre automatiquement. L'icône tray devient verte dès qu'un signal audio est détecté.


## Configuration du profil casque

HifiGuard requiert les caractéristiques électriques de votre casque pour calculer le SPL réel reçu à l'oreille. Ces valeurs se trouvent dans la fiche technique du fabricant ou sur des sites de mesures indépendantes ([Rtings.com](https://www.rtings.com), [Oratory1990](https://www.reddit.com/r/oratory1990/wiki/index/), [Crinacle](https://crinacle.com)).

| Paramètre | Description | Exemple |
|-----------|-------------|---------|
| **Sensibilité** | En dB/mW, mV/Pa ou dB/V, selon la fiche technique | `96 dB/mW` |
| **Impédance** | En Ohms (Ω) | `32 Ω` |
| **Tension Vout DAC** | Tension de sortie RMS de votre source (DAC / carte son) | `1.2 Vrms` |

La tension Vout de votre DAC ou carte son figure dans ses spécifications techniques. Pour une carte son intégrée standard, une valeur de 1,0 à 1,5 Vrms est courante.


### Formule de calcul

```
MAX_SPL = Sensibilité_dBmW + 10 × log10((Vout² / Impédance) × 1000)
SPL     = MAX_SPL + 20 × log10(RMS_signal) + Volume_Windows_dB
```

Conversions d'unités de sensibilité appliquées en interne :

```
mV/Pa  →  dB/mW :  124 − 20 × log10(valeur) + 10 × log10(Ω)
dB/V   →  dB/mW :  valeur − 10 × log10(1000 / Ω)
```


## Structure du projet

```
HifiGuard/
├── electron/           Processus principal (Electron)
│   ├── main.js
│   └── preload.js
├── ui/                 Interface utilisateur (HTML / CSS / JS)
│   ├── index.html
│   └── renderer.js
├── daemon/             Daemon audio Python
│   └── hifiguard.py
├── locales/            Traductions de l'interface
│   ├── en.json
│   └── fr.json
├── data/               Données générées — non commited
│   ├── config.json
│   ├── state.json
│   ├── suivi_audio.json
│   └── historique.csv
├── assets/             Icônes et captures d'écran
├── build.bat           Script de build Windows en un clic
└── package.json
```


## Limites et précision

HifiGuard mesure le **signal numérique** envoyé par Windows à votre casque. Les mesures sont des **approximations hautes** — elles correspondent au niveau maximal théorique que votre casque peut produire, en supposant que votre profil est correctement configuré.

Le calcul reposant sur l'architecture audio de Windows, certaines configurations matérielles ou logicielles faussent ou bloquent les mesures :

- **Atténuation analogique :** Les DAC ou amplificateurs externes dotés d'un potentiomètre de volume physique modifient le gain après la sortie PC. HifiGuard ne peut pas lire cette réduction matérielle. Pour une mesure correcte, l'amplificateur externe doit être réglé sur un volume fixe (ex. 100 %) et l'atténuation doit être gérée via Windows.

- **Bypass du mixeur (ASIO / WASAPI Exclusif) :** Les lecteurs configurés pour prendre le contrôle exclusif du périphérique de sortie (Audirvana, Foobar2000 en mode exclusif) contournent la couche d'écoute de Windows. HifiGuard affichera des résultats erronés.

- **Casques actifs (DSP interne) :** Les casques Bluetooth ou USB appliquant leur propre profil de correction en interne peuvent avoir un rendement réel différent du calcul électrique théorique. Le signal est traité matériellement à l'intérieur du casque (qui possède son propre DAC, son propre amplificateur et souvent un contrôle de volume indépendant). Le logiciel n'a aucun moyen de lire la tension de cet amplificateur interne ni de mesurer l'impact de son processeur numérique (DSP) sur le son final.


## Spécifications techniques

| Composant | Détail |
|-----------|--------|
| Capture audio | Loopback WASAPI via `soundcard` |
| Pondération fréquentielle | A-weighting, IEC 61672-1, filtre IIR via `scipy.signal` |
| Intervalle de mesure | Blocs audio de 25 ms (configurable) |
| Enregistrement CSV | 1 ligne par seconde (pic de la seconde écoulée) |
| Norme NIOSH | 85 dB(A), 8h, taux d'échange 3 dB (NIOSH 1998) |
| Norme OMS | 80 dB(A), 342 min/jour, 40h/semaine — ITU-T H.870 |
| Interface | Electron 28, Chart.js 4.4, chartjs-plugin-zoom |
| Daemon | Python 3.10+, NumPy, SciPy, soundcard, pycaw |
| Plateforme | Windows 10 / 11 (x64) |


## Développement

### Prérequis

- [Node.js](https://nodejs.org) 18+
- [Python](https://www.python.org) 3.10+
- Paquets pip : `soundcard numpy scipy pycaw comtypes`

### Lancer en mode développement

```bash
git clone https://github.com/ByronlLove/HifiGuard.git

# Installer les dépendances Node
npm install

# Installer les dépendances Python
pip install soundcard numpy scipy pycaw comtypes

# Lancer
npm start
```

Appuyez sur **F12** pour ouvrir la console DevTools.

### Build (installateur + portable)

```bash
git clone https://github.com/ByronlLove/HifiGuard.git

# Windows — double-cliquer sur build.bat
# ou en ligne de commande :

# Étape 1 — compiler le daemon Python
pyinstaller --onefile --noconsole --name hifiguard --distpath daemon/dist daemon/hifiguard.py

# Étape 2 — build Electron
npm run build
```

Les fichiers de sortie se trouvent dans `dist/`.

### Version portable

L'exécutable portable produit par `build.bat` (`HifiGuard-x.x.x-portable.exe`) ne nécessite aucune installation. Il peut être lancé directement depuis n'importe quel emplacement. Les données utilisateur sont stockées par défaut dans `%APPDATA%\HifiGuard\data\`.


## Foire aux questions (FAQ)

**Pourquoi parler d’« approximation haute » ?**
HifiGuard est conçu pour privilégier votre sécurité auditive en conservant systématiquement les valeurs maximales. Cela découle de deux choix techniques :
1. **Agrégation par pic :** Le moteur Python analyse en continu l'audio en micro-blocs (ex. 25 millisecondes). Au moment de l'écriture dans le journal d'historique, au lieu de lisser la mesure en effectuant une moyenne sur une seconde, l'algorithme ne conserve que le pic d'amplitude maximal détecté. Les bruits brefs et soudains ont donc plus de poids.
2. **Volume numérique absolu :** Le calcul suppose que votre amplificateur restitue 100 % du signal Windows. Si vous baissez le volume avec un bouton physique sur votre DAC, le logiciel l'ignore et calcule la dose sur la base du volume numérique, surestimant ainsi votre exposition réelle.

**Pourquoi le niveau dB affiché semble-t-il beaucoup plus fort que ce que j'entends ?**
C'est presque toujours dû à une erreur d'unité dans la sensibilité du casque renseignée dans les paramètres. Les fabricants ou revendeurs affichent souvent une valeur brute (ex. 106 dB) sans préciser l'unité de référence, ce qui prête à confusion.
*Exemple concret :* Le Sennheiser HD599 SE est souvent affiché à « 106 dB ». Si vous entrez 106 dans HifiGuard avec l'unité par défaut (`dB/mW`), le logiciel va massivement surestimer le volume. En réalité, Sennheiser exprime cette valeur en `dB/V` (106 dB par 1 Volt RMS). Pour ce casque, 106 dB/V équivaut à seulement **93 dB/mW**. Une simple erreur d'unité peut donc fausser vos résultats de 12 à 13 dB. Vérifiez toujours les fiches techniques officielles du fabricant.

**Pourquoi HifiGuard m'alerte-t-il alors que mon volume Windows n'est qu'à 15 % ?**
Le volume Windows n'est qu'un pourcentage d'atténuation. Si vous utilisez des écouteurs intra-auriculaires très sensibles (ex. 115 dB/mW) branchés sur un DAC très puissant (ex. 2,0 Vrms), le niveau sonore produit à 15 % de volume numérique peut déjà être physiquement dangereux pour vos oreilles. C'est précisément l'intérêt de HifiGuard : traduire un pourcentage numérique arbitraire en pression acoustique réelle.

**L'application en arrière-plan impacte-t-elle les performances (jeu, production audio) ?**
Non. Le daemon Python est optimisé pour être extrêmement léger. Bien qu'il capture le flux audio toutes les 25 millisecondes par défaut pour ne manquer aucun pic, il n'écrit sur le disque dur (fichier `.csv`) qu'une seule fois par seconde. De plus, il n'interfère pas avec le flux audio : il se contente de le « cloner » via le loopback Windows (WASAPI) sans ajouter aucune latence.

**HifiGuard fonctionne-t-il avec mon casque Bluetooth sans fil ?**
Non. Comme expliqué dans la section *Limites et précision*, les casques Bluetooth possèdent leur propre amplificateur interne et processeur de signal numérique (DSP). Windows ne leur envoie pas un signal électrique, mais des données numériques. HifiGuard ne peut donc pas appliquer ses calculs de tension et d'impédance.


## To Do

- [ ] **Correction de réponse en fréquence :** Intégration des courbes de réponse spécifiques à chaque casque ou écouteur pour un calcul SPL encore plus précis.
- [ ] **Thèmes visuels :** Support des modes d'interface « Ghost » et « Transparent ».


## Crédits

**ByronlLove** — Conception de l'architecture logicielle et du moteur d'analyse audio, 
définition des modèles de calcul dosimétrique, conception de l'expérience utilisateur (UI/UX), 
tests (QA) et déploiement.

Code source et traduction implémenté avec l'assistance de Claude (Anthropic).


## Licence

AGPL-3.0 — voir [LICENSE](LICENSE)


## Avertissement légal

HifiGuard est fourni à des fins d'information et de prévention personnelle uniquement. Les estimations de niveau sonore qu'il produit ne constituent pas des mesures médicalement certifiées et ne sauraient remplacer un bilan audiologique professionnel ou une instrumentation acoustique certifiée. Les auteurs déclinent toute responsabilité en cas de dommages auditifs, de perte d'audition ou de tout autre préjudice résultant de l'utilisation des données fournies par ce logiciel. L'utilisation de ce logiciel se fait aux risques et périls de l'utilisateur.
