import { Visual } from "../../src/visual";
import powerbiVisualsApi from "powerbi-visuals-api";
import IVisualPlugin = powerbiVisualsApi.visuals.plugins.IVisualPlugin;
import VisualConstructorOptions = powerbiVisualsApi.extensibility.visual.VisualConstructorOptions;
import DialogConstructorOptions = powerbiVisualsApi.extensibility.visual.DialogConstructorOptions;
var powerbiKey: any = "powerbi";
var powerbi: any = window[powerbiKey];
var DataCenterMockupC9F1A3C5C3B64B1FA8E0F1C2A0B1C2D3: IVisualPlugin = {
    name: 'DataCenterMockupC9F1A3C5C3B64B1FA8E0F1C2A0B1C2D3',
    displayName: 'Data Center Mockup',
    class: 'Visual',
    apiVersion: '5.3.0',
    create: (options?: VisualConstructorOptions) => {
        if (Visual) {
            return new Visual(options);
        }
        throw 'Visual instance not found';
    },
    createModalDialog: (dialogId: string, options: DialogConstructorOptions, initialState: object) => {
        const dialogRegistry = (<any>globalThis).dialogRegistry;
        if (dialogId in dialogRegistry) {
            new dialogRegistry[dialogId](options, initialState);
        }
    },
    custom: true
};
if (typeof powerbi !== "undefined") {
    powerbi.visuals = powerbi.visuals || {};
    powerbi.visuals.plugins = powerbi.visuals.plugins || {};
    powerbi.visuals.plugins["DataCenterMockupC9F1A3C5C3B64B1FA8E0F1C2A0B1C2D3"] = DataCenterMockupC9F1A3C5C3B64B1FA8E0F1C2A0B1C2D3;
}
export default DataCenterMockupC9F1A3C5C3B64B1FA8E0F1C2A0B1C2D3;