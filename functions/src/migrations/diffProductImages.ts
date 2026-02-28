import { onRequest } from "firebase-functions/v2/https";
import { db } from "../firebaseAdmin";

const STORE_A = "accounts/nfkjgp-sv.myshopify.com/products";
const STORE_B = "accounts/gj9ejg-cu.myshopify.com/products";

interface ProductImage {
  src: string;
  [key: string]: unknown;
}

interface ProductDoc {
  title: string;
  images: ProductImage[];
}

interface ImageDiff {
  title: string;
  storeWithHigherImages: string | "equal";
  difference: number;
  extraImages: { src: string; store: string }[];
  uncommonImages: { src: string; store: string }[];
}

const extractFilename = (src: string): string => {
  try {
    const pathname = new URL(src).pathname;
    return pathname.substring(pathname.lastIndexOf("/") + 1);
  } catch {
    return src;
  }
};

export const diffProductImages = onRequest(
  {
    cors: true,
    timeoutSeconds: 540,
    memory: "512MiB",
  },
  async (req, res) => {
    try {
      const [snapA, snapB] = await Promise.all([
        db.collection(STORE_A).get(),
        db.collection(STORE_B).get(),
      ]);

      // Build title -> { src, filename }[] map for each store
      const mapA = new Map<string, { src: string; filename: string }[]>();
      const mapB = new Map<string, { src: string; filename: string }[]>();

      for (const doc of snapA.docs) {
        const data = doc.data() as ProductDoc;
        if (data.title) {
          mapA.set(
            data.title,
            (data.images ?? []).map((img) => ({
              src: img.src,
              filename: extractFilename(img.src),
            })),
          );
        }
      }

      for (const doc of snapB.docs) {
        const data = doc.data() as ProductDoc;
        if (data.title) {
          mapB.set(
            data.title,
            (data.images ?? []).map((img) => ({
              src: img.src,
              filename: extractFilename(img.src),
            })),
          );
        }
      }

      const diffs: ImageDiff[] = [];

      for (const [title, imgsA] of mapA.entries()) {
        if (!mapB.has(title)) continue;

        const imgsB = mapB.get(title)!;

        const filenamesA = new Set(imgsA.map((i) => i.filename));
        const filenamesB = new Set(imgsB.map((i) => i.filename));

        const onlyInA = imgsA.filter((i) => !filenamesB.has(i.filename));
        const onlyInB = imgsB.filter((i) => !filenamesA.has(i.filename));

        if (onlyInA.length === 0 && onlyInB.length === 0) continue;

        const uncommonImages: { src: string; store: string }[] = [
          ...onlyInA.map((i) => ({ src: i.src, store: "nfkjgp-sv.myshopify.com" })),
          ...onlyInB.map((i) => ({ src: i.src, store: "gj9ejg-cu.myshopify.com" })),
        ];

        const difference = Math.abs(imgsA.length - imgsB.length);

        let storeWithHigherImages: string | "equal";
        let extraImages: { src: string; store: string }[];

        if (imgsA.length > imgsB.length) {
          storeWithHigherImages = "nfkjgp-sv.myshopify.com";
          extraImages = onlyInA
            .slice(0, difference)
            .map((i) => ({ src: i.src, store: "nfkjgp-sv.myshopify.com" }));
        } else if (imgsB.length > imgsA.length) {
          storeWithHigherImages = "gj9ejg-cu.myshopify.com";
          extraImages = onlyInB
            .slice(0, difference)
            .map((i) => ({ src: i.src, store: "gj9ejg-cu.myshopify.com" }));
        } else {
          storeWithHigherImages = "equal";
          extraImages = [];
        }

        diffs.push({
          title,
          storeWithHigherImages,
          difference,
          extraImages,
          uncommonImages,
        });
      }

      res.status(200).json({ diffs, totalDiffs: diffs.length });
    } catch (error) {
      console.error("Error diffing product images:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  },
);
