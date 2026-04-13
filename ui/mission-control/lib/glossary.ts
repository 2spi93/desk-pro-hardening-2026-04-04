export type GlossaryEntry = {
  label: string;
  simple: string;
  example: string;
  whyItMatters: string;
};

export const glossary: Record<string, GlossaryEntry> = {
  vwap: {
    label: "VWAP",
    simple: "Prix moyen pondere par le volume sur la periode.",
    example: "Si le prix reste au-dessus du VWAP, les acheteurs gardent souvent la main.",
    whyItMatters: "Ici, il aide a voir si le mouvement du chart est soutenu ou fragile.",
  },
  fvg: {
    label: "FVG",
    simple: "Zone ou le prix a traverse vite, en laissant un vide de liquidite.",
    example: "Le marche revient souvent tester un FVG avant de repartir.",
    whyItMatters: "Ici, cela aide a identifier des zones de continuation ou de rebond.",
  },
  ob: {
    label: "Order Block",
    simple: "Zone ou de gros ordres ont probablement ete places avant un mouvement fort.",
    example: "Un retour sur un order block haussier peut attirer de nouveaux acheteurs.",
    whyItMatters: "Ici, cela sert a lire les zones institutionnelles probables.",
  },
  liquidity: {
    label: "Liquidity",
    simple: "Zones ou beaucoup d'ordres ou de stops peuvent etre executes.",
    example: "Le prix peut aller chercher une poche de liquidite avant de se retourner.",
    whyItMatters: "Ici, cela aide a comprendre ou le prix peut accelerer ou pieger.",
  },
  dom: {
    label: "DOM",
    simple: "Vue live du carnet d'ordres bid/ask a plusieurs niveaux de prix.",
    example: "Un gros mur vendeur au-dessus du prix peut freiner la hausse.",
    whyItMatters: "Ici, le DOM montre si le prix avance avec vraie profondeur ou dans le vide.",
  },
  heatmap: {
    label: "Heatmap",
    simple: "Visualisation de l'intensite du carnet d'ordres selon les niveaux de prix.",
    example: "Une zone rouge persistante peut signaler une resistance.",
    whyItMatters: "Ici, elle rend visibles les concentrations de liquidite difficiles a voir autrement.",
  },
  footprint: {
    label: "Footprint",
    simple: "Vue du volume execute par niveau de prix avec delta acheteur/vendeur.",
    example: "Un delta tres positif montre souvent une aggression acheteuse nette.",
    whyItMatters: "Ici, cela aide a juger si le mouvement est reellement pousse par le flux.",
  },
  tape: {
    label: "Tape",
    simple: "Flux des executions recentes avec prix, volume et sens d'agression.",
    example: "Une serie de prints acheteurs rapides indique souvent une pression immediate.",
    whyItMatters: "Ici, le tape confirme si l'impulsion vue sur le chart est vraiment executee.",
  },
  brokers: {
    label: "Brokers / Agents / Capital",
    simple: "Etat des connecteurs, agents IA, soldes et positions disponibles pour operer.",
    example: "Un broker degrade ou un solde insuffisant peut invalider une execution pourtant valide sur le signal.",
    whyItMatters: "Ici, ce bloc donne la capacite operationnelle reelle avant de passer un ordre.",
  },
  spread: {
    label: "Spread",
    simple: "Ecart entre le meilleur prix acheteur et vendeur.",
    example: "Un spread qui s'elargit rend l'execution plus couteuse.",
    whyItMatters: "Ici, il influence directement la qualite d'execution et le cout reel.",
  },
  slippage: {
    label: "Slippage",
    simple: "Difference entre le prix attendu et le prix vraiment execute.",
    example: "Si tu veux acheter a 100 mais es rempli a 100.2, tu subis du slippage.",
    whyItMatters: "Ici, c'est un signal cle pour evaluer la route et la venue d'execution.",
  },
  latency: {
    label: "Latence",
    simple: "Temps necessaire pour recevoir, traiter et executer une decision.",
    example: "En marche rapide, 300 ms de trop peuvent changer completement le fill.",
    whyItMatters: "Ici, elle affecte la qualite du replay, de la route et des fills.",
  },
  brier: {
    label: "Brier Score",
    simple: "Mesure de calibration entre probabilites annoncees et resultats reels.",
    example: "Si un modele annonce souvent 80% de chance mais se trompe trop, son Brier monte.",
    whyItMatters: "Ici, il aide a savoir si la confiance du systeme est saine ou trompeuse.",
  },
  metaRisk: {
    label: "Meta-Risk",
    simple: "Couche de supervision qui reduit ou bloque le risque quand le systeme se degrade.",
    example: "Si plusieurs signaux se degradent ensemble, le meta-risk baisse le capital deploye.",
    whyItMatters: "Ici, il protege contre les erreurs de regime, de calibration ou d'execution.",
  },
  allocation: {
    label: "Allocation",
    simple: "Part du capital que le systeme recommande d'engager.",
    example: "Une allocation faible signifie souvent prudence, risque ou faible conviction.",
    whyItMatters: "Ici, elle synthese score, risque, correlation et conditions de marche.",
  },
  broker: {
    label: "Broker",
    simple: "Intermediaire ou plateforme qui permet d'executer et de superviser les ordres.",
    example: "Un compte MT5 branche a TXT agit comme point d'execution broker.",
    whyItMatters: "Ici, il faut savoir si l'ordre part vers un vrai broker, un exchange ou un environnement de test.",
  },
  exchange: {
    label: "Exchange",
    simple: "Plateforme d'echange centralisee ou une partie du capital peut etre connectee et executee.",
    example: "Un compte BingX ou OKX relie par cle API apparait comme source exchange.",
    whyItMatters: "Ici, cela distingue les fonds gardes sur une venue de trading des autres sources de capital.",
  },
  wallet: {
    label: "Wallet",
    simple: "Adresse ou coffre de custody qui sert surtout a conserver, suivre ou signer des fonds on-chain.",
    example: "Un wallet de reserve peut etre visible sans etre autorise a trader.",
    whyItMatters: "Ici, il faut voir si la source est juste observee, prete a signer ou seulement reservee au settlement.",
  },
  paper: {
    label: "Paper",
    simple: "Mode test ou simulation sans impact sur de l'argent reel.",
    example: "Un compte MT5 paper permet de verifier le pipeline avant de passer en live.",
    whyItMatters: "Ici, cela evite de confondre un test valide avec une vraie capacite live.",
  },
  live: {
    label: "Live",
    simple: "Mode reel avec capital, risque et execution veritables.",
    example: "Une source live doit etre verifiee avant toute allocation ou promotion.",
    whyItMatters: "Ici, c'est la frontiere entre un environnement de test et l'exploitation reelle du desk.",
  },
  portfolio: {
    label: "Portfolio",
    simple: "Ensemble organise de poches, comptes ou strategies geres sous un meme cadre de risque.",
    example: "Plusieurs sources de capital peuvent etre rattachees au meme portefeuille avec un cap USD.",
    whyItMatters: "Ici, cela permet de voir ou le capital est vraiment attache et quelles regles s'appliquent.",
  },
  hysteresis: {
    label: "Hysteresis",
    simple: "Marge de securite qui evite qu'un mode change trop souvent sur de petites variations.",
    example: "Si un seuil est juste touche puis reperdu, l'hysteresis evite un aller-retour immediat.",
    whyItMatters: "Ici, cela stabilise les changements automatiques et limite les bascules parasites.",
  },
  sparkline: {
    label: "Sparkline",
    simple: "Mini courbe compacte qui montre une tendance sans ouvrir un grand graphique.",
    example: "Une sparkline de drawdown permet de voir tout de suite si la pression monte.",
    whyItMatters: "Ici, elle donne un signal visuel rapide sans alourdir la page.",
  },
  "switches/h": {
    label: "Switches/h",
    simple: "Nombre de changements de mode ou d'etat observes par heure.",
    example: "Si le rendu change trop souvent dans l'heure, le systeme devient instable a lire.",
    whyItMatters: "Ici, ce compteur aide a verifier qu'un moteur automatique reste calme et exploitable.",
  },
  confidence: {
    label: "Confidence",
    simple: "Niveau de conviction annonce par le systeme sur sa lecture ou sa decision.",
    example: "Une confiance moyenne signifie qu'il faut lire le resultat comme une aide et non comme un ordre.",
    whyItMatters: "Ici, cela aide a separer une lecture robuste d'un signal encore fragile.",
  },
  "effective sample weight": {
    label: "Effective Sample Weight",
    simple: "Poids reel donne aux exemples recents ou comparables dans un calcul de calibration.",
    example: "Deux cents observations peuvent compter comme beaucoup moins si leur qualite est faible.",
    whyItMatters: "Ici, cela rappelle qu'un gros volume de donnees n'a pas toujours une vraie valeur statistique.",
  },
  "rolling window": {
    label: "Rolling Window",
    simple: "Fenetre glissante d'observations recentes utilisee pour recalculer une mesure en continu.",
    example: "On peut recalculer une volatilite sur les 30 derniers points a chaque nouvelle mesure.",
    whyItMatters: "Ici, cela montre si la lecture vient du contexte recent ou d'un historique trop ancien.",
  },
};