/**
 * The JNS logo recoloured to the brand teal without touching the image file:
 * the PNG is used as a CSS mask over a teal → deep-teal fill (white on the
 * dark theme). An invisible copy of the image keeps its natural size, so the
 * component sizes exactly like an <img>. Printed documents keep the original
 * artwork; this is for on-screen chrome only.
 */
export function BrandLogo({ src, alt, className = '' }: { src: string; alt: string; className?: string }) {
  return (
    <span className={'brand-mask inline-block ' + className} style={{ ['--logo' as string]: `url(${src})` }} role="img" aria-label={alt}>
      <img src={src} alt="" aria-hidden className="block h-full w-auto invisible" />
    </span>
  );
}
