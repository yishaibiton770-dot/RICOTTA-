const ricottaMedia = (() => {
  const originalHeroURL = "https://i.postimg.cc/FR4RTRyW/21d15421-7223-4efe-9e38-6ea5a941ac0b-20251125-135133-0000.png";
  const originalHero = {"src":"/assets/ricotta-v1/hero-1280.webp","srcset":"/assets/ricotta-v1/hero-960.webp 960w, /assets/ricotta-v1/hero-1280.webp 1280w"};
  const products = new Map([
    ["https://i.postimg.cc/0yqHh34y/1.png", {"src":"/assets/ricotta-v1/dubai-256.webp","srcset":"/assets/ricotta-v1/dubai-256.webp 256w, /assets/ricotta-v1/dubai-640.webp 640w"}],
    ["https://i.postimg.cc/HkCPFKNY/4.png", {"src":"/assets/ricotta-v1/brulee-256.webp","srcset":"/assets/ricotta-v1/brulee-256.webp 256w, /assets/ricotta-v1/brulee-640.webp 640w"}],
    ["https://i.postimg.cc/fRjgsC40/3.png", {"src":"/assets/ricotta-v1/lemon-256.webp","srcset":"/assets/ricotta-v1/lemon-256.webp 256w, /assets/ricotta-v1/lemon-640.webp 640w"}],
    ["https://i.postimg.cc/pVmWdhLy/blwbryz-z-yyz.png", {"src":"/assets/ricotta-v1/blueberry-256.webp","srcset":"/assets/ricotta-v1/blueberry-256.webp 256w, /assets/ricotta-v1/blueberry-640.webp 640w"}],
    ["https://i.postimg.cc/RZzb28YF/5.png", {"src":"/assets/ricotta-v1/oreo-256.webp","srcset":"/assets/ricotta-v1/oreo-256.webp 256w, /assets/ricotta-v1/oreo-640.webp 640w"}],
    ["https://i.postimg.cc/DwKYRDN1/2.png", {"src":"/assets/ricotta-v1/almond-256.webp","srcset":"/assets/ricotta-v1/almond-256.webp 256w, /assets/ricotta-v1/almond-640.webp 640w"}],
  ]);

  return {
    hero: url => !url || url === originalHeroURL ? originalHero : { src: url },
    product: url => products.get(url) || { src: url },
  };
})();
