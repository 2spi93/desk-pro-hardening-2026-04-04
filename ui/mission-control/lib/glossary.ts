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
};