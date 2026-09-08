'use client';

import { Dialog, DialogTrigger, DialogContent, DialogTitle, DialogDescription, DialogClose } from '../components/ui/dialog';

type Screenshot = { src: string; alt: string; caption: string };

export default function ScreenshotGallery({ name, images }: { name: string; images: Screenshot[] }) {
  const previews = images.slice(0, 5);

  return <div className="template-screenshots" aria-label={`${name} screenshots`}>
    {previews.map((img, index) => <Dialog key={img.src}>
      <DialogTrigger className="screenshot-trigger" aria-label={`Preview ${name} screenshot ${index + 1} of ${previews.length}`}>
        <img src={img.src} alt={img.alt} width="240" height="160" />
      </DialogTrigger>
      <DialogContent className="screenshot-modal" showCloseButton={false}>
        <div className="screenshot-modal-header">
          <DialogTitle>{name}{previews.length > 1 ? ` (${index + 1}/${previews.length})` : ''}</DialogTitle>
          <DialogClose className="screenshot-close">Close</DialogClose>
        </div>
        <img className="screenshot-full" src={img.src} alt={img.alt} width="960" height="640" />
        <DialogDescription>{img.caption}</DialogDescription>
        <a className="screenshot-original" href={img.src} target="_blank" rel="noreferrer">Open original image</a>
      </DialogContent>
    </Dialog>)}
  </div>;
}
