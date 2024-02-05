const fs = require("node:fs");
const PromiseThrottle = require("promise-throttle");
const FormData = require("form-data");
const { traverse } = require("object-traversal");
const sizeOf = require("image-size");
const StoryblokClient = require("storyblok-js-client");
const { v4: uuidv4 } = require("uuid");
const jsonpointer = require("jsonpointer");
const designSystemPresets = require("@kickstartds/ds-agency/presets.json");
const generatedComponents = require("../storyblok/components.123456.json");

require("dotenv").config({ path: ".env.local" });

if (!process.env.NEXT_PUBLIC_STORYBLOK_SPACE_ID)
  throw new Error("Missing NEXT_PUBLIC_STORYBLOK_SPACE_ID env variable");
if (!process.env.NEXT_PUBLIC_STORYBLOK_OAUTH_TOKEN)
  throw new Error("Missing NEXT_PUBLIC_STORYBLOK_OAUTH_TOKEN env variable");

/** Configuration */
const componentScreenshotAssetFolderName = "Component Screenshots";
const demoContentAssetFolderName = "Demo Content";

const Storyblok = new StoryblokClient({
  oauthToken: process.env.NEXT_PUBLIC_STORYBLOK_OAUTH_TOKEN,
});

const presets = {};
const images = new Map();
const promiseThrottle = new PromiseThrottle({
  requestsPerSecond: 2,
  promiseImplementation: Promise,
});

const presetIdToComponentName = (id) =>
  id.split("--").shift().split("-").slice(1).join("-");

const groupToComponentName = (name) => name.split("/").pop().trim();

const upload = (signed_request, file) => {
  return new Promise((resolve, reject) => {
    const form = new FormData();
    for (let key in signed_request.fields) {
      form.append(key, signed_request.fields[key]);
    }
    form.append("file", fs.createReadStream(file));
    form.submit(signed_request.post_url, (err, res) => {
      if (err) reject(err);
      return resolve(res);
    });
  });
};

const signedUpload = async (fileName, assetFolderId) => {
  return new Promise(async (resolve, reject) => {
    let dimensions = sizeOf(
      "./node_modules/@kickstartds/ds-agency/dist/static/" + fileName
    );

    const assetResponse = await Storyblok.post(
      `spaces/${process.env.NEXT_PUBLIC_STORYBLOK_SPACE_ID}/assets/`,
      {
        filename: fileName,
        size: `${dimensions.width}x${dimensions.height}`,
        asset_folder_id: assetFolderId || null,
      }
    );
    await upload(
      assetResponse.data,
      "./node_modules/@kickstartds/ds-agency/dist/static/" + fileName
    );

    return resolve({
      id: assetResponse.data.id,
      url: assetResponse.data.pretty_url,
    });
  });
};

const createAssetFolder = async (folderName) =>
  Storyblok.post(
    `spaces/${process.env.NEXT_PUBLIC_STORYBLOK_SPACE_ID}/asset_folders/`,
    {
      asset_folder: {
        name: folderName,
      },
    }
  );

const getAssetsForFolder = async (folderId) =>
  Storyblok.get(
    `spaces/${process.env.NEXT_PUBLIC_STORYBLOK_SPACE_ID}/assets?per_page=100&page=1&in_folder=${folderId}`
  );

const deleteAsset = async (assetId) =>
  Storyblok.delete(
    `spaces/${process.env.NEXT_PUBLIC_STORYBLOK_SPACE_ID}/assets/${assetId}`
  );

const deleteAssetFolder = async (folderId) =>
  Storyblok.delete(
    `spaces/${process.env.NEXT_PUBLIC_STORYBLOK_SPACE_ID}/asset_folders/${folderId}`
  );

const generate = async () => {
  const assetFolders = (
    await Storyblok.get(
      `spaces/${process.env.NEXT_PUBLIC_STORYBLOK_SPACE_ID}/asset_folders/`
    )
  ).data?.asset_folders;

  const componentScreenshotFolders = assetFolders.filter(
    (assetFolder) => assetFolder.name === componentScreenshotAssetFolderName
  );
  const demoContentFolders = assetFolders.filter(
    (assetFolder) => assetFolder.name === demoContentAssetFolderName
  );

  for (const componentScreenshotFolder of componentScreenshotFolders) {
    const { assets } = (
      await promiseThrottle.add(
        getAssetsForFolder.bind(this, componentScreenshotFolder.id)
      )
    ).data;

    for (const asset of assets) {
      await promiseThrottle.add(deleteAsset.bind(this, asset.id));
    }

    await promiseThrottle.add(
      deleteAssetFolder.bind(this, componentScreenshotFolder.id)
    );
  }

  for (const demoContentFolder of demoContentFolders) {
    const { assets } = (
      await promiseThrottle.add(
        getAssetsForFolder.bind(this, demoContentFolder.id)
      )
    ).data;

    for (const asset of assets) {
      await promiseThrottle.add(deleteAsset.bind(this, asset.id));
    }

    await promiseThrottle.add(
      deleteAssetFolder.bind(this, demoContentFolder.id)
    );
  }

  const previewsFolderId = (
    await promiseThrottle.add(
      createAssetFolder.bind(this, componentScreenshotAssetFolderName)
    )
  ).data.asset_folder.id;
  const demoFolderId = (
    await promiseThrottle.add(
      createAssetFolder.bind(this, demoContentAssetFolderName)
    )
  ).data.asset_folder.id;

  for (const preset of designSystemPresets) {
    const component_id = generatedComponents.components.find(
      (component) =>
        component.display_name.trim() === groupToComponentName(preset.group)
    )?.id;

    if (component_id) {
      const componentKey = presetIdToComponentName(preset.id);

      presets[preset.id] = {
        id: 0,
        name: preset.name,
        preset: {
          _uid: uuidv4(),
          type: componentKey,
          component: componentKey,
          ...preset.args,
        },
        component_id,
        space_id: process.env.NEXT_PUBLIC_STORYBLOK_SPACE_ID,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        color: "",
        icon: "",
        description: "",
      };

      if (!images.has(preset.screenshot)) {
        const image = signedUpload.bind(
          this,
          preset.screenshot,
          previewsFolderId
        );
        images.set(preset.screenshot, (await promiseThrottle.add(image)).url);
      }
      presets[preset.id].image = images.get(preset.screenshot);
    }
  }

  const presetImages = [];

  for (const [presetId, preset] of Object.entries(presets)) {
    const component = generatedComponents.components.find(
      (component) => component.name === presetIdToComponentName(presetId)
    );
    traverse(
      preset.preset,
      ({ meta }) => {
        const config = jsonpointer.get(component.schema, `/${meta.nodePath}`);
        if (!config) return;
        if (config.type === "bloks") {
          jsonpointer.set(
            preset.preset,
            `/${meta.nodePath}`,
            jsonpointer.get(preset.preset, `/${meta.nodePath}`).map((entry) => {
              if (typeof entry !== "object") return entry;
              return {
                ...entry,
                _uid: uuidv4(),
                type: config.component_whitelist[0],
                component: config.component_whitelist[0],
              };
            })
          );
        }
      },
      { pathSeparator: "/" }
    );
  }

  traverse(presets, ({ parent, key, value }) => {
    if (value && typeof value === "string" && value.startsWith("img/")) {
      presetImages.push({ parent, key, value });
    }
  });

  for (const presetImage of presetImages) {
    if (!images.has(presetImage.value)) {
      const image = signedUpload.bind(this, presetImage.value, demoFolderId);
      images.set(presetImage.value, (await promiseThrottle.add(image)).url);
    }

    presetImage.parent[presetImage.key] = images.get(presetImage.value);
  }

  fs.writeFileSync(
    "storyblok/presets.123456.json",
    JSON.stringify({ presets: [...Object.values(presets)] }, null, 2)
  );
};

generate();