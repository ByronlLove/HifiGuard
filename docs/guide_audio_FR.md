# Calcul du niveau sonore dB

**dBFS · dB(Z) · dB(A) · SPL**

## 1. Les échantillons audio

Un fichier audio est une suite de nombres entre **-1** et **+1**, appelés **échantillons**. Chaque nombre représente la position de la membrane du haut-parleur à un instant précis.

*   +1.0 = membrane poussée au maximum vers l'avant
*   -1.0 = membrane tirée au maximum vers l'arrière
*   0 = silence

À 44 100 Hz, l'ordinateur prend **44 100 mesures par seconde**.


## 2. Le dBFS (niveau numérique)

Le dBFS mesure l'amplitude du signal numérique **par rapport au maximum possible (1.0)**.

**Depuis le RMS du signal :**

$$\text{RMS} = \sqrt{\frac{1}{n}\sum_{i=1}^{n} x_i^2}$$

$$\text{dBFS} = 20 \times \log_{10}(\text{RMS})$$

**Depuis le % Windows :**

$$\text{dBFS} = 20 \times \log_{10}\left(\frac{\%}{100}\right)$$

> Note : cette formule suppose que le fichier audio est à 0 dBFS. Si ton fichier est à -10 dBFS : dBFS total = -10 + 20 × log10(% / 100)

**Propriétés :**

*   Toujours négatif ou nul (on ne peut pas dépasser 1.0)
*   0 dBFS = maximum absolu
*   -30 dBFS = signal à 3,16% du maximum

**Exemples :**

|% Windows|dBFS     |
|---------|---------|
|100%     |0 dBFS   |
|50%      |-6 dBFS  |
|10%      |-20 dBFS |


## 3. Du dBFS au dB SPL (Z) — le MAX_SPL

Le **dB SPL** (Sound Pressure Level) est la pression acoustique réelle dans l'air. Pour passer du numérique à l'acoustique, il faut les specs du matériel.

$$\text{MAX\\_SPL} = S_{\text{dBmW}} + 10 \times \log_{10}\left(\frac{V_{\text{out}}^2}{R} \times 1000\right)$$

$$\text{dB(Z) SPL} = \text{MAX\\_SPL} + \text{dBFS}$$

**Paramètres :**

*   $S_{\text{dB/mW}}$ : sensibilité du casque en dB/mW
*   $V_{\text{out}}$ : tension de sortie du DAC en Vrms
*   $R$ : impédance du casque en Ω
*   $\times 1000$ : conversion watts → milliwatts

**Exemple numérique :**

- Casque Artti T10 : 96 dB/mW, 16,5 Ω - DAC : 1,2 Vrms - Peace UI Equalizer APO : -30 Pre-Amp.


## 4. Le filtre A — pondération de l'oreille

L'oreille humaine n'entend pas toutes les fréquences de la même façon. Le filtre A imite cette sensibilité. Pour chaque fréquence $f$ (en Hz) :

$$R_A(f) = \frac{12194^2 \cdot f^4}{\left(f^2 + 20{,}6^2\right) \cdot \sqrt{\left(f^2 + 107{,}7^2\right)\left(f^2 + 737{,}9^2\right)} \cdot \left(f^2 + 12194^2\right)}$$

$$G_A(f) = 20 \times \log_{10}(R_A(f)) + 2{,}00$$

**Valeurs typiques :**

|Fréquence|Type de son   |$G_A(f)$|Effet               |
|---------|--------------|--------|--------------------|
|50 Hz    |Basse profonde|-30,2 dB|Fortement atténué   |
|1 000 Hz |Voix humaine  |≈ 0 dB  |Référence, inchangé |
|4 000 Hz |Sifflement    |+1 dB   |Légèrement amplifié |
|10 000 Hz|Cymbales      |-2,5 dB |Légèrement atténué  |


## 5. Le dB(A) — formule complète

$$\text{dB(A)} = \text{MAX\\_SPL} + 20\log_{10}\left(\frac{\%}{100}\right) + G_A(f)$$

Ou plus simplement :

$$\text{dB(A)} = \text{dB(Z) SPL} + G_A(f)$$

**En pratique**, un signal musical contient des centaines de fréquences simultanées. On calcule $G_A(f)$ pour chaque fréquence (via FFT), puis on somme les contributions.

**Exemple :**

- Avec le même casque, Artti T10, 50% Windows (-6 dBFS), fréquence 1 000 Hz :

$$\text{dB(A)} = 115{,}4 + (-6) + 0{,}1 = 109{,}5 \text{ dB(A)}$$

**Dangereux** — exposition prolongée déconseillée au-delà de quelques minutes.


## 6. Récapitulatif des formules

|Calcul               |Formule                      |
|---------------------|-----------------------------|
|Facteur de volume    |10^(dBFS/20)                 |
|dBFS depuis % Windows|20 × log10(% / 100)          |
|RMS du signal        |sqrt( (1/n) × somme(xi²) )   |
|dBFS depuis RMS      |20 × log10(RMS)              |
|MAX_SPL              |S + 10 × log10(V² / R × 1000)|
|dB(Z) SPL            |MAX_SPL + dBFS               |
|Gain filtre A        |20 × log10(RA(f)) + 2        |
|dB(A) SPL            |dB(Z) SPL + GA(f)            |

**Seuils de danger (OMS / NIOSH) :** 80 dB(A) sur 40h/semaine / 85 dB(A) sur 8h/jour
