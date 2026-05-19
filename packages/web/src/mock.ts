export default {};
export const createJiti = () => ({});
export const fileURLToPath = () => "";
export const dirname = () => "";
export const resolve = () => "";
export const existsSync = () => false;
export const extname = (p: string) => {
	const match = p.match(/\.[^.]+$/);
	return match ? match[0] : "";
};
export const readFile = async () => "";
export const relative = () => "";
export const mkdir = async () => {};
export const writeFile = async () => {};
