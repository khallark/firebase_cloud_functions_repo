export const parseJson = (t: string) => {
  try {
    return JSON.parse(t);
  } catch {
    return { raw: t };
  }
};
