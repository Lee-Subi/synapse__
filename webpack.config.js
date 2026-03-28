const path = require("path");

/** @type {import('webpack').Configuration} */
const extensionConfig = {
  name: "extension",
  target: "node",
  mode: "none",
  entry: "./src/extension.ts",
  output: {
    path: path.resolve(__dirname, "dist"),
    filename: "extension.js",
    libraryTarget: "commonjs2",
  },
  externals: { vscode: "commonjs vscode" },
  resolve: { extensions: [".ts", ".js"] },
  module: {
    rules: [{ test: /\.ts$/, use: "ts-loader", exclude: /node_modules/ }],
  },
  devtool: "nosources-source-map",
};

/** @type {import('webpack').Configuration} */
const webviewConfig = {
  name: "webview",
  target: "web",
  mode: "none",
  entry: "./src/webview/index.tsx",
  output: {
    path: path.resolve(__dirname, "dist/webview"),
    filename: "webview.js",
  },
  resolve: { extensions: [".ts", ".tsx", ".js", ".jsx"] },
  module: {
    rules: [
      { test: /\.tsx?$/, use: "ts-loader", exclude: /node_modules/ },
      {
        test: /\.css$/,
        use: ["style-loader", "css-loader", "postcss-loader"],
      },
    ],
  },
  devtool: "nosources-source-map",
};

module.exports = [extensionConfig, webviewConfig];
