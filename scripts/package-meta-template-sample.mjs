import { mkdir, copyFile } from 'node:fs/promises';
const filename='14af14ebb7b71df4b0a32d31ba7d8df82a7d18f47e56143a4bc0b5ea46587717.jpeg';
for(const root of ['dist','dist-cli']) {const destination=new URL(`../${root}/assets/meta-template-samples/v1/`,import.meta.url);await mkdir(destination,{recursive:true});await copyFile(new URL(`../assets/meta-template-samples/v1/${filename}`,import.meta.url),new URL(filename,destination));}
